/**
 * Yarn Process DC PDFs (yarn to dyeing / twisting / winding … — the outward DC of the yarn process engine and the
 * older per-process yarn DC) on the shared print engine — client voice notes 05-Nov-2026: one design for every DC
 * (Colour / Black & White), our company on top, billing (us) + delivery (process unit) always printed, IO No,
 * Prepared By / Checked By / Received By (Process Unit), nothing cut, no rate / amount.
 *
 * Grid (job-wise, as the old challans): S.No | IO No (PO · style · process no under it) | Yarn | Yarn Colour / Shade |
 * Dye Colour (dyeing only) | Lot No. | Cone No. | Cones | GRN No. | Wt (KG). Job totals when the DC has several jobs.
 */
import { renderDocPdf, type Cell, type Column, type EwaySpec, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';
import { dcAddresses, humanStatus, partyIdLines, statusWatermark, type PrintParty } from '../../core/print/dcPrint.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const kg = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const int = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 });

export interface YarnDcLine {
  io_no: string | null; buyer_po_no?: string | null; style_code?: string | null; process_no?: string | null;
  yarn: string; shade?: string | null; target_shade?: string | null; lot_no?: string | null; cone_no?: string | null;
  cones: number; grn_no?: string | null; kg: number;
}
export interface YarnDcHead {
  dc_no: string; dc_date: string; status: string; process: string; dyeing: boolean;
  vendor_name: string | null; vendor_gstin?: string | null; challan_no?: string | null; reprocess_no?: string | null;
  from_store?: string | null; to_location?: string | null; vehicle_no?: string | null; expected_return?: string | null;
  remarks?: string | null; cancel_reason?: string | null; issued_status?: string[];
}

export async function renderYarnProcessDcPdf(o: {
  template: PrintTemplate; company: PrintCompany; h: YarnDcHead; lines: YarnDcLine[]; party: PrintParty | null; eway: EwaySpec | null;
  reprint: string | null; printedAt: string; printedBy: string | null; meta: string;
}): Promise<Buffer> {
  const { h, lines, company: co, party } = o;
  const hasCone = lines.some((l) => l.cone_no);
  const hasGrn = lines.some((l) => l.grn_no);
  const hasShade = lines.some((l) => l.shade);
  const columns: Column[] = [
    { key: 'sn', label: 'S.No', align: 'center', wrap: false },
    { key: 'io', label: 'IO No', bold: true, weight: 0.8, maxWidth: 120 },
    { key: 'yarn', label: 'Yarn', weight: 2.2 },
    ...(hasShade || h.dyeing ? [{ key: 'shade', label: h.dyeing ? 'Yarn Colour' : 'Shade', weight: 0.7 } as Column] : []),
    ...(h.dyeing ? [{ key: 'dye', label: 'Dye Colour', weight: 0.7 } as Column] : []),
    { key: 'lot', label: 'Lot No.', weight: 0.5, maxWidth: 90 },
    ...(hasCone ? [{ key: 'cone', label: 'Cone No.', weight: 0.5, maxWidth: 90 } as Column] : []),
    { key: 'cones', label: 'Cones', align: 'right', wrap: false },
    ...(hasGrn ? [{ key: 'grn', label: 'GRN No.', weight: 0.5, maxWidth: 100 } as Column] : []),
    { key: 'kg', label: 'Wt (KG)', align: 'right', wrap: false },
  ];
  const keys = columns.map((c) => c.key);
  const row = (v: Record<string, Cell>) => keys.map((k) => v[k] ?? '');
  const jobs: { io: string; rows: YarnDcLine[] }[] = [];
  for (const l of lines) {
    const io = l.io_no || '-';
    let j = jobs.find((x) => x.io === io);
    if (!j) { j = { io, rows: [] }; jobs.push(j); }
    j.rows.push(l);
  }
  const rows: Cell[][] = [];
  let sn = 0;
  for (const j of jobs) {
    j.rows.forEach((l, i) => {
      sn += 1;
      const sub = i === 0 ? [l.buyer_po_no ? `PO ${l.buyer_po_no}` : null, l.style_code ? `Style ${l.style_code}` : null] : [];
      if (l.process_no && (i === 0 || l.process_no !== j.rows[i - 1].process_no)) sub.push(`Process ${l.process_no}`);
      rows.push(row({
        sn: String(sn), io: { text: j.io, sub: sub.filter(Boolean) as string[] }, yarn: l.yarn || '-',
        shade: l.shade || '', dye: l.target_shade || '', lot: l.lot_no || '', cone: l.cone_no || '',
        cones: n(l.cones) ? int(n(l.cones)) : '', grn: l.grn_no || '', kg: kg(n(l.kg)),
      }));
    });
    if (jobs.length > 1) {
      rows.push(row({
        yarn: { text: 'Job total', bold: true },
        cones: { text: int(j.rows.reduce((a, l) => a + n(l.cones), 0)), bold: true },
        kg: { text: kg(j.rows.reduce((a, l) => a + n(l.kg), 0)), bold: true },
      }));
    }
  }
  const totKg = lines.reduce((a, l) => a + n(l.kg), 0);
  const totCones = lines.reduce((a, l) => a + n(l.cones), 0);

  const details: [string, string][] = [['DC No.', h.dc_no], ['DC Date', h.dc_date], ['Process', h.process]];
  if (h.challan_no) details.push(['Challan No.', h.challan_no]);
  if (h.reprocess_no) details.push(['Reprocess Of', h.reprocess_no]);
  if (h.from_store) details.push(['From Store', h.from_store]);
  if (h.to_location) details.push(['To', h.to_location]);
  details.push(['Vehicle No.', h.vehicle_no || '-']);
  if (h.expected_return) details.push(['Expected Return', h.expected_return]);
  const issued = h.issued_status ?? [];
  if (!issued.includes(h.status)) details.push(['Status', humanStatus(h.status)]);

  const notes: [string, string][] = [['Jobs', `${jobs.length} job(s) · ${lines.length} line(s) · ${int(totCones)} cones · ${kg(totKg)} KG`]];
  if (h.remarks) notes.push(['Remarks', h.remarks]);
  if (h.status === 'CANCELLED' && h.cancel_reason) notes.push(['Cancelled', h.cancel_reason]);
  const live = h.status !== 'DRAFT' && h.status !== 'CANCELLED';

  return renderDocPdf({
    template: o.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: `Yarn Process – ${h.process}`,
    docNoLabel: 'DC No.', docNo: h.dc_no,
    party: { heading: 'Issued to (Process Unit)', name: h.vendor_name ?? party?.name ?? '-', lines: partyIdLines({ gstin: party?.gstin ?? h.vendor_gstin, phone: party?.phone }) },
    details,
    // the gate scans the DC No. (Code 128) — the old challan carried the same barcode
    barcode: live ? { value: h.dc_no, caption: 'Scan at gate' } : null,
    banner: h.status === 'CANCELLED' && h.cancel_reason ? `CANCELLED — ${h.cancel_reason}` : null,
    // delivery: the process unit's address (party master), else the DC's "to process location", else ours
    addresses: dcAddresses(co, { name: h.vendor_name, lines: party?.address?.length ? party.address : (h.to_location ? [h.to_location] : []), gstin: party?.gstin ?? h.vendor_gstin }),
    eway: o.eway,
    table: { columns, rows, total: { label: 'Grand Total', values: { cones: int(totCones), kg: kg(totKg) } }, emptyText: 'No yarn on this DC' },
    summary: { notes },
    footerNote: `Yarn sent for job work (${h.process}) — to be returned after processing, not for sale.`,
    signatures: [{ label: 'Prepared By' }, { label: 'Checked By' }, { label: 'Received By (Process Unit)' }],
    watermark: statusWatermark(h.status),
    reprint: o.reprint,
    printedAt: o.printedAt, printedBy: o.printedBy,
    meta: { title: `${o.meta} ${h.dc_no}`, subject: `Delivery Challan – Yarn ${h.process}` },
  });
}
