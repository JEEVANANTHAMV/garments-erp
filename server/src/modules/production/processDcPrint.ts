/**
 * Process / job-work Delivery Challan PDF (process outward to a contractor, an in-house unit, embroidery / printing
 * / washing …) on the shared print engine — client voice notes 05-Nov-2026: one design for every DC (Colour or
 * Black & White), our logo + company on top, billing (us) + delivery (contractor / unit) always printed, IO No
 * (never Job No), Prepared By / Checked By / Received By, e-way bill panel when the DC has one, nothing cut.
 *
 * Grid (one row per job → colour → size, as the old challan): S.No | IO No (buyer · PO under it) | Item (style +
 * description / part, assort colour) | Colour | Size | Bundle Nos (PCS) | Bundles | PCS | Wt (KG). Bundle columns
 * only when the DC carries bundles; weight only when any line has one. Job total rows when the DC has several
 * jobs; the colour × size breakdown, operations and remarks go in the notes under the grid.
 * No rate / amount: the job-work rate is the processing charge, not the goods value (not a valued challan).
 */
import { renderDocPdf, type Cell, type Column, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';
import { dcParty, dmy, humanStatus, statusWatermark, type PrintParty } from '../../core/print/dcPrint.js';
import type { EwaySpec } from '../../core/print/docPdf.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const int = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const kg = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const uniq = (xs: unknown[]) => [...new Set(xs.map((x) => String(x ?? '').trim()).filter(Boolean))];

export async function renderProcessDcPdf(o: {
  template: PrintTemplate; company: PrintCompany; dc: any; party: PrintParty | null; eway: EwaySpec | null;
  reprint: string | null; printedAt: string; printedBy: string | null;
}): Promise<Buffer> {
  const { dc, company: co, party } = o;
  const lines: any[] = dc.lines ?? [];
  const jobsMeta = new Map<string, any>((dc.summary?.jobs ?? []).map((j: any) => [j.io_no ?? '—', j]));
  const isUnit = !!dc.unit_id;
  const hasBundles = lines.some((l) => l.bundle_no);
  const hasWeight = lines.some((l) => n(l.weight_kg) > 0);
  const stage = String(dc.stage_name ?? '').trim();

  // job → colour → size groups, in the DC's own order (lines come sorted io, colour, size, bundle)
  type G = { io: string; color: string; size: string; rows: any[] };
  const groups: G[] = [];
  for (const l of lines) {
    const io = l.job_io_no ?? '—'; const color = l.color_name ?? '—'; const size = l.size_code ?? '—';
    let g = groups.find((x) => x.io === io && x.color === color && x.size === size);
    if (!g) { g = { io, color, size, rows: [] }; groups.push(g); }
    g.rows.push(l);
  }
  const jobOrder = uniq(groups.map((g) => g.io));
  const multiJob = jobOrder.length > 1;

  const columns: Column[] = [
    { key: 'sn', label: 'S.No', align: 'center', wrap: false },
    { key: 'io', label: 'IO No', bold: true, weight: 0.8, maxWidth: 120 },
    { key: 'item', label: 'Item / Description', weight: 1.6 },
    { key: 'color', label: 'Colour', weight: 0.9 },
    { key: 'size', label: 'Size', weight: 0.4, maxWidth: 60 },
    ...(hasBundles ? [{ key: 'bundles', label: 'Bundle Nos (PCS)', weight: 2 } as Column, { key: 'nb', label: 'Bundles', align: 'right', wrap: false } as Column] : []),
    { key: 'pcs', label: 'PCS', align: 'right', wrap: false },
    ...(hasWeight ? [{ key: 'kg', label: 'Wt (KG)', align: 'right', wrap: false } as Column] : []),
  ];
  const keys = columns.map((c) => c.key);
  const row = (v: Record<string, Cell>) => keys.map((k) => v[k] ?? '');

  const rows: Cell[][] = [];
  let sn = 0;
  for (const io of jobOrder) {
    const jg = groups.filter((g) => g.io === io);
    const m = jobsMeta.get(io) ?? {};
    jg.forEach((g, gi) => {
      sn += 1;
      const items = uniq(g.rows.map((l) => [l.style_code, l.description, l.part].filter(Boolean).join(' · ')));
      const assort = uniq(g.rows.map((l) => l.assort_color));
      const ops = uniq(g.rows.map((l) => l.operation_name));
      // whatever was typed on the DC lines prints under the item (client 06-Nov-2026)
      const notesTyped = uniq(g.rows.map((l) => String(l.remarks ?? '').trim()).filter(Boolean));
      const qty = g.rows.reduce((a, l) => a + n(l.qty), 0);
      const w = g.rows.reduce((a, l) => a + n(l.weight_kg), 0);
      rows.push(row({
        sn: String(sn),
        io: gi === 0
          ? { text: io === '—' ? '-' : io, sub: [m.buyer_name, m.buyer_po_no ? `PO ${m.buyer_po_no}` : null].filter(Boolean) as string[] }
          : (io === '—' ? '-' : io),
        item: { text: items.join('\n') || '-', sub: [...(assort.length ? [`Assort: ${assort.join(', ')}`] : []), ...(ops.length ? [`Operation: ${ops.join(', ')}`] : []), ...notesTyped] },
        color: g.color === '—' ? '-' : g.color,
        size: g.size === '—' ? '-' : g.size,
        bundles: g.rows.map((l) => (l.bundle_no ? `${l.bundle_no} (${int(n(l.qty))})` : null)).filter(Boolean).join(', ') || '-',
        nb: int(g.rows.filter((l) => l.bundle_no).length),
        pcs: int(qty),
        kg: w ? kg(w) : '',
      }));
    });
    if (multiJob) {
      const ls = jg.flatMap((g) => g.rows);
      rows.push(row({
        item: { text: 'Job total', bold: true },
        nb: { text: int(ls.filter((l) => l.bundle_no).length), bold: true },
        pcs: { text: int(ls.reduce((a, l) => a + n(l.qty), 0)), bold: true },
        kg: hasWeight ? { text: kg(ls.reduce((a, l) => a + n(l.weight_kg), 0)), bold: true } : '',
      }));
    }
  }
  const totQty = lines.reduce((a, l) => a + n(l.qty), 0);
  const totKg = lines.reduce((a, l) => a + n(l.weight_kg), 0);
  const totalValues: Record<string, string> = { pcs: int(totQty) };
  if (hasBundles) totalValues.nb = int(lines.filter((l) => l.bundle_no).length);
  if (hasWeight) totalValues.kg = kg(totKg);

  // colour × size breakdown (the old challan's matrix) as notes
  const notes: [string, string][] = [];
  const s = dc.summary;
  if (s?.colors?.length && s.sizes?.length) {
    const txt = s.colors.map((c: any) => `${c.color_name === "—" ? "No colour" : c.color_name}: ${c.sizes.filter((z: any) => n(z.qty)).map((z: any) => `${z.size_code} ${int(n(z.qty))}`).join(' · ')} = ${int(n(c.qty))}`).join('\n');
    notes.push(['Colour / Size', `${txt}\nTotal: ${s.sizeTotals.filter((z: any) => n(z.qty)).map((z: any) => `${z.size_code} ${int(n(z.qty))}`).join(' · ')} = ${int(n(s.totals?.qty))} PCS`]);
  }
  if (dc.operations?.length) notes.push(['Operations', dc.operations.map((x: any) => x.op_name).join(', ')]);
  notes.push(['Jobs', `${jobOrder.filter((x) => x !== '—').length || jobOrder.length} job(s) · ${int(totQty)} PCS${hasWeight ? ` · ${kg(totKg)} KG` : ''}`]);
  if (dc.remarks) notes.push(['Remarks', String(dc.remarks)]);
  if (dc.status === 'CANCELLED' && dc.cancel_reason) notes.push(['Cancelled', String(dc.cancel_reason)]);

  const details: [string, string][] = [
    ['DC No.', dc.challan_no], ['DC Date', dmy(dc.challan_date)], ['Process', stage || '-'],
  ];
  if (dc.ref_no) details.push(['Ref / SR No.', String(dc.ref_no)]);
  if (dc.jw_no) details.push(['Job Work Order', `${dc.jw_no}${dc.jw_line_seq ? ` / ${dc.jw_line_seq}` : ''}`]);
  details.push(['From', dc.from_location || '-'], ['To', dc.to_location || '-']);
  details.push(['Vehicle No.', dc.vehicle_no || '-']);
  if (dc.driver_name) details.push(['Driver', String(dc.driver_name)]);
  if (dc.transporter) details.push(['Transporter', String(dc.transporter)]);
  if (dc.expected_return) details.push(['Expected Return', dmy(dc.expected_return)]);
  if (dc.status !== 'ISSUED') details.push(['Status', humanStatus(dc.status)]);

  const shipLines = isUnit
    ? [dc.unit_address, dc.unit_city].map((x) => String(x ?? '').trim()).filter(Boolean)
    : party?.address ?? [];
  const role = isUnit ? 'In-house Unit' : 'Contractor';

  return renderDocPdf({
    template: o.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: `Job Work – ${stage || 'Process'}${isUnit ? ' (In-house Unit)' : ''}`,
    docNoLabel: 'DC No.', docNo: dc.challan_no,
    // supplier (or our in-house unit) with its address; no party code, no billing / shipping boxes (06-Nov-2026)
    party: dcParty(isUnit ? 'Unit' : 'Supplier', dc.vendor_name, { address: shipLines, gstin: isUnit ? null : (party?.gstin ?? dc.vendor_gstin), phone: isUnit ? null : (party?.phone ?? dc.vendor_phone) }),
    details,
    // the gate scans the DC No. (Code 128) to load the DC into the gate pass
    barcode: dc.status !== 'DRAFT' && dc.status !== 'CANCELLED' ? { value: dc.challan_no, caption: 'Scan at gate' } : null,
    banner: dc.status === 'CANCELLED' && dc.cancel_reason ? `CANCELLED — ${dc.cancel_reason}` : null,
    eway: o.eway,
    table: { columns, rows, total: { label: 'Grand Total', values: totalValues }, emptyText: 'No items on this DC' },
    summary: { notes },
    footerNote: 'Goods sent for job work and to be returned after processing — not for sale.',
    signatures: [{ label: 'Prepared By', name: dc.issued_by_name ?? dc.created_by_name ?? null }, { label: 'Checked By' }, { label: `Received By (${role})` }],
    watermark: statusWatermark(dc.status),
    reprint: o.reprint,
    printedAt: o.printedAt, printedBy: o.printedBy,
    meta: { title: `Process DC ${dc.challan_no}`, subject: `Delivery Challan – Job Work ${stage}` },
  });
}
