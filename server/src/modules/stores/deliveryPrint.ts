/**
 * Stock Delivery / General Delivery DC PDF on the shared print engine — client voice notes 05-Nov-2026: one design for
 * every DC (Colour / Black & White), our company on top, billing (us) + delivery (party) always printed, IO No,
 * Prepared By / Checked By / Received By (Party), e-way bill panel, gate barcode (the gate pass is made from the DC).
 * These DCs had no printout before. No rate / value printed (client: DCs carry no rate / amount — the stores value is
 * internal; a billable delivery is billed by its own invoice).
 *
 * Grid: S.No | IO No | Item / Description (item + description, colour, sizes, remarks) | Qty | UOM | Returned (only once
 * goods came back).
 */
import { renderDocPdf, type Cell, type Column, type EwaySpec, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';
import { dcAddresses, dmy, humanStatus, partyIdLines, statusWatermark, type PrintParty } from '../../core/print/dcPrint.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const q3 = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export async function renderDeliveryDcPdf(o: {
  template: PrintTemplate; company: PrintCompany; h: any; party: PrintParty | null; eway: EwaySpec | null;
  reprint: string | null; printedAt: string; printedBy: string | null;
}): Promise<Buffer> {
  const { h, company: co, party } = o;
  const lines: any[] = h.lines ?? [];
  const general = h.delivery_kind === 'GENERAL';
  const returnable = h.dc_type === 'RETURNABLE';
  const hasRet = lines.some((l) => n(l.returned_qty) > 0);
  const columns: Column[] = [
    { key: 'sn', label: 'S.No', align: 'center', wrap: false },
    { key: 'io', label: 'IO No', bold: true, weight: 0.7, maxWidth: 120 },
    { key: 'item', label: 'Item / Description', weight: 3 },
    { key: 'qty', label: 'Qty', align: 'right', wrap: false },
    { key: 'uom', label: 'UOM', wrap: false },
    ...(hasRet ? [{ key: 'ret', label: 'Returned', align: 'right', wrap: false } as Column, { key: 'bal', label: 'Balance', align: 'right', wrap: false } as Column] : []),
  ];
  const keys = columns.map((c) => c.key);
  const rows: Cell[][] = lines.map((l, i) => {
    const desc = l.item_description && l.item_description !== l.item_name ? String(l.item_description) : null;
    const sub = [desc, [l.color_name ? `Colour: ${l.color_name}` : null, l.sizes ? `Sizes: ${l.sizes}` : null].filter(Boolean).join(' · ') || null,
      l.remarks ? `Note: ${l.remarks}` : null].filter(Boolean) as string[];
    const v: Record<string, Cell> = {
      sn: String(i + 1), io: l.io_no || h.so_no || '-', item: { text: String(l.item_name || l.item_description || '-'), sub },
      qty: q3(n(l.qty)), uom: l.uom_code || '', ret: q3(n(l.returned_qty)), bal: q3(n(l.qty) - n(l.returned_qty)),
    };
    return keys.map((k) => v[k] ?? '');
  });
  const byUom = new Map<string, number>();
  for (const l of lines) byUom.set(l.uom_code || '', (byUom.get(l.uom_code || '') ?? 0) + n(l.qty));
  const oneUom = byUom.size === 1;

  const type = returnable ? 'Returnable' : `Non-returnable · ${Number(h.is_billable) ? 'Billable' : 'Non-billable (FOC)'}`;
  const details: [string, string][] = [['DC No.', h.doc_no], ['DC Date', dmy(h.doc_date)], ['DC Type', type]];
  if (h.party_dc_no) details.push(['Party DC No.', String(h.party_dc_no)]);
  if (h.so_no) details.push(['IO No', String(h.so_no)]);
  if (h.style_code) details.push(['Style', String(h.style_code)]);
  if (h.warehouse_name) details.push(['From Location', String(h.warehouse_name)]);
  if (returnable && h.expected_return_date) details.push(['Return By', dmy(h.expected_return_date)]);
  details.push(['Vehicle No.', h.vehicle_no || '-']);
  if (h.gate_pass_no) details.push(['Gate Pass', String(h.gate_pass_no)]);
  if (h.status !== 'APPROVED') details.push(['Status', humanStatus(h.status)]);

  const notes: [string, string][] = [];
  if (h.purpose) notes.push(['Purpose', String(h.purpose)]);
  if (!oneUom && byUom.size) notes.push(['Total Qty', [...byUom.entries()].map(([u, v]) => `${q3(v)} ${u}`).join(' · ')]);
  if (h.remarks) notes.push(['Remarks', String(h.remarks)]);
  if (h.cancel_reason) notes.push([h.status === 'CANCELLED' ? 'Cancelled' : 'Closed', String(h.cancel_reason)]);
  const live = !['DRAFT', 'CANCELLED'].includes(String(h.status));

  return renderDocPdf({
    template: o.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: `${general ? 'General Delivery' : 'Stock Delivery'} – ${returnable ? 'Returnable' : 'Non-returnable'}`,
    docNoLabel: 'DC No.', docNo: h.doc_no,
    party: { heading: 'Delivered to (Party)', name: h.party_name ?? party?.name ?? '-', lines: partyIdLines(party) },
    details,
    barcode: live ? { value: h.doc_no, caption: 'Scan at gate' } : null,
    banner: h.status === 'CANCELLED' && h.cancel_reason ? `CANCELLED — ${h.cancel_reason}` : null,
    addresses: dcAddresses(co, { name: h.party_name ?? party?.name, lines: party?.address ?? [], gstin: party?.gstin }),
    eway: o.eway,
    table: { columns, rows, total: { label: 'Total', values: oneUom ? { qty: q3([...byUom.values()][0] ?? 0), uom: [...byUom.keys()][0] ?? '' } : {} }, emptyText: 'No items on this DC' },
    summary: notes.length ? { notes } : null,
    footerNote: returnable ? 'Returnable goods — to be returned to us by the date above.' : (Number(h.is_billable) ? null : 'Free of cost — not for sale.'),
    signatures: [{ label: 'Prepared By', name: h.prepared_by ?? null }, { label: 'Checked By' }, { label: 'Received By (Party)' }],
    watermark: statusWatermark(h.status),
    reprint: o.reprint,
    printedAt: o.printedAt, printedBy: o.printedBy,
    meta: { title: `${general ? 'General' : 'Stock'} Delivery DC ${h.doc_no}`, subject: 'Delivery Challan' },
  });
}
