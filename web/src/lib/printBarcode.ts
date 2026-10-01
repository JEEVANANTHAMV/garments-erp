import { code128Svg } from './barcode';

/**
 * Barcode block for printed DCs / GRNs (client voice note 01-Oct-2026): the document number as a
 * Code 128 barcode, so scanning it at the gate loads the DC. Returns '' for a draft (no number yet).
 */
export function barcodeHtml(docNo: string | null | undefined, label = 'Scan at gate'): string {
  const no = String(docNo ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9/_-]*\d/.test(no) || no.length > 40) return '';
  return `<div style="float:right;text-align:center;margin:0 0 6px 12px">${code128Svg(no, { height: 44, module: 1.5 })}`
    + `<div style="font:bold 11px monospace;letter-spacing:1px">${no.replace(/[&<>"]/g, '')}</div><div style="font:9px Arial;color:#666">${label}</div></div>`;
}
