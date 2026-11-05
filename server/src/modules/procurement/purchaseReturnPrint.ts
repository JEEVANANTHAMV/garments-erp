/**
 * Purchase Return Delivery Challan PDF (goods going back to the supplier) on the shared print engine — client voice
 * notes 05-Nov-2026: same design as every DC (Colour / Black & White), our company on top, billing (us) + delivery
 * (supplier) always printed, IO No, Prepared By / Checked By / Received By (Supplier), e-way bill panel, gate barcode.
 *
 * VALUED challan: a return to the supplier is a supply — the e-way bill (document type "Delivery Challan") is made
 * from this DC's taxable value, and the old Return DC already printed Rate + Amount. So this DC keeps Rate and
 * Taxable Value per line and the GST / total value under the grid (the only DC that prints values).
 *
 * Grid: S.No | IO No | Item / Description (item + lot / dye lot / roll / batch / GSM / dia / size / colour / reason) |
 * Pkgs (rolls / cones / bags) | Qty | UOM | Rate | Taxable Value.
 */
import { renderDocPdf, type Cell, type EwaySpec, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';
import { dcAddresses, dmy, humanStatus, partyIdLines, statusWatermark, type PrintParty } from '../../core/print/dcPrint.js';
import { amountInWords, fmtMoney } from '../../core/print/printText.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const q3 = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const r2 = (v: number) => Math.round(v * 100) / 100;

export function returnLineDescription(l: any): { text: string; sub: string[] } {
  const item = l.yarn_name || l.fabric_name || l.trim_name || l.item_name || l.remarks || l.material_type || 'Material';
  const spec = [
    l.color_name ? `Colour: ${l.color_name}` : null,
    l.lot_no ? `Lot: ${l.lot_no}` : null, l.dye_lot_no ? `Dye lot: ${l.dye_lot_no}` : null,
    l.roll_no ? `Roll: ${l.roll_no}` : null, l.batch_no ? `Batch: ${l.batch_no}` : null,
    l.gsm ? `GSM: ${l.gsm}` : null, l.dia ? `Dia: ${l.dia}` : null, l.size ? `Size: ${l.size}` : null,
    l.style_no ? `Style: ${l.style_no}` : null,
  ].filter(Boolean).join(' · ');
  const note = l.remarks && l.remarks !== item ? `Note: ${l.remarks}` : null;
  const sub = [spec, note, l.reason ? `Reason: ${String(l.reason).replace(/_/g, ' ').toLowerCase()}` : null, l.material_type ? `Material: ${String(l.material_type).toLowerCase()}` : null]
    .filter(Boolean) as string[];
  return { text: String(item), sub };
}

export async function renderPurchaseReturnDcPdf(o: {
  template: PrintTemplate; company: PrintCompany; pr: any; lines: any[]; party: PrintParty | null; eway: EwaySpec | null;
  reprint: string | null; printedAt: string; printedBy: string | null;
}): Promise<Buffer> {
  const { pr, lines, company: co, party } = o;
  const dcNo = pr.return_dc_no || pr.return_no;
  const taxable = (l: any) => n(l.taxable_amount) || n(l.basic_amount) || n(l.amount) || r2(n(l.return_qty) * n(l.rate));
  const rows: Cell[][] = lines.map((l, i) => {
    const pk = [n(l.cone_count) ? `${n(l.cone_count)} cones` : null, n(l.bag_count) ? `${n(l.bag_count)} bags` : null, l.roll_no ? '1 roll' : null].filter(Boolean).join('\n');
    return [String(i + 1), l.job_no || '-', returnLineDescription(l), pk || '-', q3(n(l.return_qty)), l.uom_code || '', fmtMoney(n(l.rate)), fmtMoney(taxable(l))];
  });
  const tTax = lines.reduce((a, l) => a + taxable(l), 0);
  const cgst = lines.reduce((a, l) => a + n(l.cgst_amount), 0);
  const sgst = lines.reduce((a, l) => a + n(l.sgst_amount), 0);
  const igst = lines.reduce((a, l) => a + n(l.igst_amount), 0);
  const grand = r2(tTax + cgst + sgst + igst);
  const qtyByUom = new Map<string, number>();
  for (const l of lines) qtyByUom.set(l.uom_code || '', (qtyByUom.get(l.uom_code || '') ?? 0) + n(l.return_qty));
  const oneUom = qtyByUom.size === 1;

  const details: [string, string][] = [['DC No.', dcNo], ['DC Date', dmy(pr.return_dc_date || pr.return_date)], ['Return No.', pr.return_no], ['Return Date', dmy(pr.return_date)]];
  if (pr.grn_no) details.push(['Against GRN', pr.grn_no]);
  if (pr.po_no) details.push(['PO No.', pr.po_no]);
  details.push(['Reason', humanStatus(pr.return_reason) || '-'], ['Vehicle No.', pr.vehicle_no || '-']);
  if (pr.transporter_name) details.push(['Transporter', pr.transporter_name]);
  if (pr.driver_name) details.push(['Driver', pr.driver_name]);
  if (pr.warehouse_name) details.push(['From Store', pr.warehouse_name]);

  const notes: [string, string][] = [];
  if (!oneUom) notes.push(['Total Qty', [...qtyByUom.entries()].map(([u, v]) => `${q3(v)} ${u}`).join(' · ')]);
  if (pr.remarks) notes.push(['Remarks', String(pr.remarks)]);
  const sumRows: [string, string][] = [['Taxable Value', fmtMoney(tTax)]];
  if (cgst) sumRows.push(['CGST', fmtMoney(cgst)]);
  if (sgst) sumRows.push(['SGST', fmtMoney(sgst)]);
  if (igst) sumRows.push(['IGST', fmtMoney(igst)]);

  const draft = !pr.return_dc_no;
  return renderDocPdf({
    template: o.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: 'Purchase Return',
    docNoLabel: 'DC No.', docNo: dcNo,
    party: { heading: 'Returned to (Supplier)', name: pr.supplier_name ?? party?.name ?? '-', lines: partyIdLines(party, true) },
    details,
    // the gate scans the DC No. to make the outward pass
    barcode: !draft && pr.status !== 'CANCELLED' ? { value: dcNo, caption: 'Scan at gate' } : null,
    banner: draft ? 'Return DC not generated yet — not valid for dispatch' : null,
    addresses: dcAddresses(co, { name: pr.supplier_name ?? party?.name, lines: party?.address ?? [], gstin: party?.gstin }),
    eway: o.eway,
    table: {
      columns: [
        { key: 'sn', label: 'S.No', align: 'center', wrap: false },
        { key: 'io', label: 'IO No', bold: true, weight: 0.6, maxWidth: 110 },
        { key: 'desc', label: 'Item / Description', weight: 3 },
        { key: 'pk', label: 'Pkgs', weight: 0.5, maxWidth: 70 },
        { key: 'qty', label: 'Qty', align: 'right', wrap: false },
        { key: 'uom', label: 'UOM', wrap: false },
        { key: 'rate', label: 'Rate', align: 'right', wrap: false },
        { key: 'val', label: 'Taxable Value', align: 'right', wrap: false },
      ],
      rows,
      total: { label: 'Total', values: { ...(oneUom ? { qty: q3([...qtyByUom.values()][0] ?? 0), uom: [...qtyByUom.keys()][0] ?? '' } : {}), val: fmtMoney(tTax) } },
      emptyText: 'No items on this return',
    },
    summary: { notes, rows: sumRows, grand: ['Total Value', `INR ${fmtMoney(grand)}`], amountInWords: grand ? amountInWords(grand, 'INR') : null },
    footerNote: 'Goods returned to the supplier — not for sale.',   // as on the old Return DC
    signatures: [{ label: 'Prepared By' }, { label: 'Checked By' }, { label: 'Received By (Supplier)' }],
    watermark: draft ? 'DRAFT' : statusWatermark(pr.status),
    reprint: o.reprint,
    printedAt: o.printedAt, printedBy: o.printedBy,
    meta: { title: `Purchase Return DC ${dcNo}`, subject: 'Delivery Challan – Purchase Return' },
  });
}
