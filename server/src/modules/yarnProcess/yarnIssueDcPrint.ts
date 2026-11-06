/**
 * Knitting – Yarn Issue Delivery Challan PDF on the shared print engine (core/print/docPdf.ts) — client voice notes
 * 05-Nov-2026: same design family as every PO / DC (Colour or Black & White), our logo + company on top (no software
 * branding, no decorative images), billing (us) + delivery (contractor) address always printed, e-way bill panel with
 * the QR only from a verified payload, Prepared By / Checked By / Received By.
 *
 * Grid: S.No | IO No | Knitting Program (program no + the program's fabric under it) | Yarn (the yarn NAME as
 * stored / bought — no composition percentages) | Lot No. | Cones | Net Wt (KG). No rate, amount or gross weight.
 */
import { renderDocPdf, type EwaySpec, type PrintCompany, type PrintTemplate } from '../../core/print/docPdf.js';

export interface KnitDcPrint {
  template: PrintTemplate;
  company: PrintCompany;
  dc: {
    dc_no: string; dc_date: string; doc_status: string; contractor: string | null; contractor_address: string | null;
    contractor_gstin: string | null; contractor_phone?: string | null; vehicle_no: string | null; purpose: string | null; cancel_reason?: string | null;
  };
  lines: { io_no: string; program_no: string | null; program_fabric: string | null; yarn: string; lot_no: string | null; cones: number; net_kg: number }[];
  eway: null | {
    eway_bill_no: string | null; date_text: string | null; valid_until_text: string | null; expired: boolean; distance_km: number | null;
    transport_mode: string | null; transporter_name: string | null; transporter_gstin: string | null; vehicle_no: string | null;
    /** only a payload from the official e-way bill response (verifiedQr) — never made up */
    qr_payload: string | null; status: string;
  };
  print: { reprint_no: number; printed_at: string; printed_by: string | null };
}

const fmtKg = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtInt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** The yarn as named in the master / on the DC, without composition percentages ("100% Organic Cotton 10s" → "Organic Cotton 10s"). */
export function yarnNameForPrint(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/\([^()]*\d\s?%[^()]*\)/g, ' ')            // "(100% Cotton)" / "(60% CTN 40% PES)" — a composition in brackets
    .replace(/\b\d{1,3}(?:\.\d+)?\s?%\s*/g, ' ')          // "100% Organic Cotton" → "Organic Cotton"
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,/–-]+|[\s,/–-]+$/g, '')
    .trim();
}

export async function renderKnitDcPdf(d: KnitDcPrint): Promise<Buffer> {
  const co = d.company;
  const stamp = d.dc.doc_status === 'CANCELLED' ? 'CANCELLED' : d.dc.doc_status === 'DRAFT' ? 'DRAFT' : null;
  const contractorLines = [d.dc.contractor_gstin ? `GSTIN: ${d.dc.contractor_gstin}` : null, d.dc.contractor_phone ? `Ph: ${d.dc.contractor_phone}` : null].filter(Boolean) as string[];
  const contractorAddress = String(d.dc.contractor_address ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  const e = d.eway;
  const eway: EwaySpec | null = e ? {
    title: 'E-Way Bill',
    fields: [
      ['E-Way Bill No.', e.eway_bill_no || (e.status === 'PENDING' ? 'Pending details' : '-')],
      ['E-Way Bill Date', e.date_text || '-'],
      ['Valid Until', e.valid_until_text ? `${e.valid_until_text}${e.expired ? '  (EXPIRED)' : ''}` : '-'],
      ['Approx. Distance', e.distance_km != null ? `${String(Number(e.distance_km.toFixed(2)))} KM` : '-'],
      ['Transport Mode', e.transport_mode || '-'],
      ['Transporter', e.transporter_name || '-'],
      ['Transporter GSTIN', e.transporter_gstin || '-'],
      ['Vehicle No.', e.vehicle_no || '-'],
    ],
    qrPayload: e.qr_payload || null,
    qrCaption: 'E-Way Bill QR',
  } : null;

  const details: [string, string][] = [['DC No.', d.dc.dc_no], ['DC Date', d.dc.dc_date], ['Vehicle No.', d.dc.vehicle_no || '-'], ['Purpose', d.dc.purpose || '-']];
  if (d.dc.doc_status !== 'APPROVED') details.push(['Status', d.dc.doc_status.charAt(0) + d.dc.doc_status.slice(1).toLowerCase()]);

  return renderDocPdf({
    template: d.template,
    company: co,
    title: 'DELIVERY CHALLAN',
    subtitle: 'Knitting – Yarn Issue',
    docNoLabel: 'DC No.', docNo: d.dc.dc_no,
    // supplier = the knitting contractor with its address (as on the DC); no billing / shipping boxes (06-Nov-2026)
    party: { heading: 'Supplier', name: d.dc.contractor ?? '-', lines: [...contractorAddress, ...contractorLines] },
    details,
    // the gate scans the DC No. (Code 128) to load the DC — approved DCs only
    barcode: d.dc.doc_status === 'APPROVED' ? { value: d.dc.dc_no, caption: 'Scan at gate' } : null,
    banner: d.dc.doc_status === 'CANCELLED' && d.dc.cancel_reason ? `CANCELLED — ${d.dc.cancel_reason}` : null,
    eway,
    table: {
      columns: [
        { key: 'sn', label: 'S.No', align: 'center', wrap: false },
        { key: 'io', label: 'IO No', bold: true, weight: 0.6, maxWidth: 104 },
        { key: 'prog', label: 'Knitting Program', weight: 2 },
        { key: 'yarn', label: 'Yarn', weight: 2 },
        { key: 'lot', label: 'Lot No.', weight: 0.5, maxWidth: 90 },
        { key: 'cones', label: 'Cones', align: 'right', wrap: false },
        { key: 'net', label: 'Net Wt (KG)', align: 'right', wrap: false },
      ],
      rows: d.lines.map((l, i) => [
        String(i + 1),
        l.io_no || '-',
        { text: l.program_no || '-', bold: true, sub: l.program_fabric ? [`Fabric: ${l.program_fabric}`] : null },
        yarnNameForPrint(l.yarn) || '-',
        l.lot_no ?? '',
        fmtInt(l.cones),
        fmtKg(l.net_kg),
      ]),
      total: {
        label: 'Total',
        values: { cones: fmtInt(d.lines.reduce((a, l) => a + (Number(l.cones) || 0), 0)), net: fmtKg(d.lines.reduce((a, l) => a + (Number(l.net_kg) || 0), 0)) },
      },
      emptyText: 'No yarn on this DC',
    },
    summary: null,
    signatures: [{ label: 'Prepared By' }, { label: 'Checked By' }, { label: 'Received By (Contractor)' }],
    watermark: stamp,
    reprint: d.print.reprint_no > 1 ? `Reprint ${d.print.reprint_no}` : null,
    printedAt: d.print.printed_at, printedBy: d.print.printed_by,
    meta: { title: `Knitting Yarn Issue DC ${d.dc.dc_no}`, subject: 'Knitting – Yarn Issue / Delivery Challan' },
  });
}
