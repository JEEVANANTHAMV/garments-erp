/**
 * Fabric Process Outward DC PDF (fabric to dyeing / washing / compacting / printing …) on the shared print engine —
 * client voice notes 05-Nov-2026: one design for every DC (Colour / Black & White), our company on top, billing (us)
 * + delivery (process unit) always printed, IO No, Prepared By / Checked By / Received By (Process Unit), nothing cut.
 *
 * Grid (as the old challan, job-wise): S.No | IO No (PO · style under it) | Roll No | Lot | Fabric | Fabric Colour |
 * Dye Colour (dyeing) / Colour | GSM | Dia | Wt (KG) | Mtr (only when any roll has metres). Job totals when the DC
 * carries several jobs. No rate (the quotation rate is billed at inward, not printed on the DC).
 */
import { renderDocPdf, type Cell, type Column, type EwaySpec, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';
import { dcAddresses, dmy, humanStatus, partyIdLines, statusWatermark, type PrintParty } from '../../core/print/dcPrint.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const kg = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const mtr = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function renderFabricProcessDcPdf(o: {
  template: PrintTemplate; company: PrintCompany; dc: any; rolls: any[]; party: PrintParty | null; eway: EwaySpec | null;
  reprint: string | null; printedAt: string; printedBy: string | null;
}): Promise<Buffer> {
  const { dc, rolls, company: co, party } = o;
  const dyeing = /DYE/i.test(String(dc.sub_process ?? ''));
  const hasMtr = rolls.some((r) => n(r.meters) > 0);
  const proc = String(dc.process_name || dc.sub_process || 'Process');
  const columns: Column[] = [
    { key: 'sn', label: 'S.No', align: 'center', wrap: false },
    { key: 'io', label: 'IO No', bold: true, weight: 0.8, maxWidth: 120 },
    { key: 'roll', label: 'Roll No', weight: 0.6, maxWidth: 100 },
    { key: 'lot', label: 'Lot', weight: 0.5, maxWidth: 90 },
    { key: 'fab', label: 'Fabric', weight: 2 },
    ...(dyeing
      ? [{ key: 'fc', label: 'Fabric Colour', weight: 0.8 } as Column, { key: 'dc', label: 'Dye Colour', weight: 0.8 } as Column]
      : [{ key: 'dc', label: 'Colour', weight: 0.8 } as Column]),
    { key: 'gsm', label: 'GSM', wrap: false },
    { key: 'dia', label: 'Dia', weight: 0.4, maxWidth: 70 },
    { key: 'kg', label: 'Wt (KG)', align: 'right', wrap: false },
    ...(hasMtr ? [{ key: 'mtr', label: 'Mtr', align: 'right', wrap: false } as Column] : []),
  ];
  const keys = columns.map((c) => c.key);
  const row = (v: Record<string, Cell>) => keys.map((k) => v[k] ?? '');

  const jobs: { io: string; rows: any[] }[] = [];
  for (const r of rolls) {
    const io = r.io_no || '-';
    let j = jobs.find((x) => x.io === io);
    if (!j) { j = { io, rows: [] }; jobs.push(j); }
    j.rows.push(r);
  }
  const rows: Cell[][] = [];
  let sn = 0;
  for (const j of jobs) {
    j.rows.forEach((r, i) => {
      sn += 1;
      rows.push(row({
        sn: String(sn),
        io: i === 0 ? { text: j.io, sub: [r.buyer_po_no ? `PO ${r.buyer_po_no}` : null, r.style_code ? `Style ${r.style_code}` : null].filter(Boolean) as string[] } : j.io,
        roll: r.roll_no || '-', lot: r.lot_no || '',
        fab: r.fabric_name || '-',
        fc: r.fabric_color || '', dc: (dyeing ? r.color_name : (r.color_name || r.fabric_color)) || '',
        gsm: r.gsm != null && r.gsm !== '' ? String(r.gsm) : '', dia: r.dia || '',
        kg: kg(n(r.weight_kg)), mtr: n(r.meters) ? mtr(n(r.meters)) : '',
      }));
    });
    if (jobs.length > 1) {
      rows.push(row({
        fab: { text: `Job total — ${j.rows.length} roll(s)`, bold: true },
        kg: { text: kg(j.rows.reduce((a, r) => a + n(r.weight_kg), 0)), bold: true },
        mtr: hasMtr ? { text: mtr(j.rows.reduce((a, r) => a + n(r.meters), 0)), bold: true } : '',
      }));
    }
  }
  const totKg = rolls.reduce((a, r) => a + n(r.weight_kg), 0);
  const total: Record<string, string> = { kg: kg(totKg) };
  if (hasMtr) total.mtr = mtr(rolls.reduce((a, r) => a + n(r.meters), 0));

  const details: [string, string][] = [['DC No.', dc.fpo_no], ['DC Date', dmy(dc.fpo_date)], ['Process', proc]];
  if (dc.challan_no) details.push(['Challan No.', String(dc.challan_no)]);
  if (dc.reprocess_no) details.push(['Reprocess Of', String(dc.reprocess_no)]);
  if (dc.from_store) details.push(['From Store', String(dc.from_store)]);
  details.push(['To', dc.to_location || '-'], ['Vehicle No.', dc.vehicle_no || '-']);
  if (dc.expected_return_date) details.push(['Expected Return', dmy(dc.expected_return_date)]);
  if (String(dc.status) !== 'DISPATCHED') details.push(['Status', humanStatus(dc.status)]);

  const notes: [string, string][] = [['Jobs', `${jobs.length} job(s) · ${rolls.length} roll(s) · ${kg(totKg)} KG`]];
  if (dc.remarks) notes.push(['Remarks', String(dc.remarks)]);
  if (dc.status === 'CANCELLED' && dc.cancel_reason) notes.push(['Cancelled', String(dc.cancel_reason)]);

  return renderDocPdf({
    template: o.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: `Fabric Process – ${proc}`,
    docNoLabel: 'DC No.', docNo: dc.fpo_no,
    party: { heading: 'Issued to (Process Unit)', name: dc.vendor_name ?? party?.name ?? '-', lines: partyIdLines({ gstin: party?.gstin ?? dc.vendor_gstin, phone: party?.phone }) },
    details,
    // the gate scans the DC No. (Code 128) — the old challan carried the same barcode
    barcode: dc.status !== 'DRAFT' && dc.status !== 'CANCELLED' ? { value: dc.fpo_no, caption: 'Scan at gate' } : null,
    banner: dc.status === 'CANCELLED' && dc.cancel_reason ? `CANCELLED — ${dc.cancel_reason}` : null,
    addresses: dcAddresses(co, { name: dc.vendor_name, lines: party?.address ?? [], gstin: party?.gstin ?? dc.vendor_gstin }),
    eway: o.eway,
    table: { columns, rows, total: { label: `Grand Total — ${rolls.length} roll(s)`, values: total }, emptyText: 'No rolls on this DC' },
    summary: { notes },
    footerNote: `Goods sent for job work (${proc}) and to be returned after processing — not for sale.`,
    signatures: [{ label: 'Prepared By' }, { label: 'Checked By' }, { label: 'Received By (Process Unit)' }],
    watermark: statusWatermark(dc.status),
    reprint: o.reprint,
    printedAt: o.printedAt, printedBy: o.printedBy,
    meta: { title: `Fabric Process DC ${dc.fpo_no}`, subject: `Delivery Challan – Fabric ${proc}` },
  });
}
