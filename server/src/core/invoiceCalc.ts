/**
 * Common invoice financial summary (Bills Inward, GRNs, general inward).
 * Server mirror of web/src/lib/invoiceCalc.ts — keep the two in step. The
 * server recomputes on save so the stored totals never trust the client.
 *
 * Order of computation:
 *   1. Taxable subtotal   = Σ line taxable values
 *   2. GST                = Σ line taxable × GST%   (CGST+SGST halves intra-state, IGST otherwise)
 *   3. Landed charges     = freight + insurance + customs duty + clearing
 *   4. Other charges      = ± amount (sign chosen by the user)
 *   5. TCS                = (1 + 2 + 3 + 4) × TCS%   — added
 *   6. TDS                = 1 × TDS%                 — deducted (on value excl. GST)
 *   7. Net payable        = 1 + 2 + 3 + 4 + 5 − 6 + round off
 */

export type GstMode = 'INTRA_STATE' | 'INTER_STATE' | 'IMPORT';

export interface InvoiceLineInput {
  /** Taxable value of the line (after any line discount). */
  taxable: number;
  /** GST % of the line. */
  gst_rate?: number;
  /** Explicit tax of the line; overrides taxable × gst_rate when given. */
  tax?: number;
}

/** Header-level fields the summary block edits. All optional, default 0. */
export interface InvoiceCharges {
  freight_charges?: number;
  insurance?: number;
  customs_duty?: number;
  clearing_charges?: number;
  other_charges?: number;
  other_charges_sign?: number;
  other_charges_label?: string;
  tds_section?: string;
  tds_pct?: number;
  tcs_section?: string;
  tcs_pct?: number;
  round_off?: number;
}

export interface InvoiceTotals {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  /** Per GST-rate breakup for display. */
  gstGroups: { rate: number; taxable: number; tax: number }[];
  landed: number;
  otherSigned: number;
  tcsBase: number;
  tcs: number;
  tds: number;
  /** Net before round off. */
  preRound: number;
  roundOff: number;
  net: number;
}

export const EMPTY_CHARGES: Required<InvoiceCharges> = {
  freight_charges: 0, insurance: 0, customs_duty: 0, clearing_charges: 0,
  other_charges: 0, other_charges_sign: 1, other_charges_label: '',
  tds_section: '', tds_pct: 0, tcs_section: '', tcs_pct: 0, round_off: 0,
};

/** Common TDS sections for purchases / job work. */
export const TDS_SECTIONS = [
  { value: '194Q', label: '194Q – Purchase of goods', pct: 0.1 },
  { value: '194C-I', label: '194C – Contractor (Individual/HUF)', pct: 1 },
  { value: '194C', label: '194C – Contractor (Others)', pct: 2 },
  { value: '194J', label: '194J – Professional / technical', pct: 10 },
  { value: '194H', label: '194H – Commission / brokerage', pct: 5 },
  { value: '194I', label: '194I – Rent (plant / machinery)', pct: 2 },
] as const;

/** TCS on purchase: sec 206C(1H) — 0.1% above the ₹50 lakh threshold. */
export const TCS_SECTIONS = [
  { value: '206C(1H)', label: '206C(1H) – Sale of goods', pct: 0.1 },
] as const;

const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function computeInvoice(
  lines: InvoiceLineInput[],
  gstMode: GstMode,
  charges: InvoiceCharges = {},
): InvoiceTotals {
  const groups = new Map<number, { rate: number; taxable: number; tax: number }>();
  let taxable = 0;
  let gst = 0;
  for (const l of lines) {
    const base = n(l.taxable);
    const rate = n(l.gst_rate);
    const tax = l.tax !== undefined && l.tax !== null ? n(l.tax) : (base * rate) / 100;
    taxable += base;
    gst += tax;
    const g = groups.get(rate) ?? { rate, taxable: 0, tax: 0 };
    g.taxable += base;
    g.tax += tax;
    groups.set(rate, g);
  }
  taxable = r2(taxable);
  gst = r2(gst);
  const intra = gstMode === 'INTRA_STATE';
  const cgst = intra ? r2(gst / 2) : 0;
  const sgst = intra ? r2(gst - cgst) : 0;
  const igst = intra ? 0 : gst;

  const landed = r2(n(charges.freight_charges) + n(charges.insurance) + n(charges.customs_duty) + n(charges.clearing_charges));
  const sign = n(charges.other_charges_sign) < 0 ? -1 : 1;
  const otherSigned = r2(sign * Math.abs(n(charges.other_charges)));

  const tcsBase = r2(taxable + gst + landed + otherSigned);
  const tcs = r2((Math.max(0, tcsBase) * n(charges.tcs_pct)) / 100);
  const tds = r2((taxable * n(charges.tds_pct)) / 100);
  const preRound = r2(tcsBase + tcs - tds);
  const roundOff = r2(n(charges.round_off));
  const net = r2(preRound + roundOff);

  return {
    taxable, cgst, sgst, igst, gst,
    gstGroups: [...groups.values()]
      .filter((g) => g.taxable || g.tax)
      .map((g) => ({ rate: g.rate, taxable: r2(g.taxable), tax: r2(g.tax) }))
      .sort((a, b) => a.rate - b.rate),
    landed, otherSigned, tcsBase, tcs, tds, preRound, roundOff, net,
  };
}

/** Round off that brings the net to the nearest whole rupee. */
export const autoRoundOff = (t: Pick<InvoiceTotals, 'preRound'>) => r2(Math.round(t.preRound) - t.preRound);

/** Header columns written by the summary, per table naming. */
export interface InvoiceColumnMap {
  /** Column holding the TCS % (trx_grn uses tcs_rate). */
  tcsPct?: string;
  /** Column holding the net payable. */
  net: string;
  taxable?: string;
  gst?: string;
}

/** Read the summary fields from a (merged) header row. */
export function chargesFromRow(row: Record<string, any>, tcsPctKey = 'tcs_pct'): InvoiceCharges {
  return {
    freight_charges: n(row.freight_charges),
    insurance: n(row.insurance),
    customs_duty: n(row.customs_duty),
    clearing_charges: n(row.clearing_charges),
    other_charges: Math.abs(n(row.other_charges)),
    other_charges_sign: n(row.other_charges_sign) < 0 ? -1 : 1,
    tds_pct: n(row.tds_pct),
    tcs_pct: n(row[tcsPctKey]),
    round_off: n(row.round_off),
  };
}

/** Write the computed totals into an INSERT/UPDATE data object. */
export function writeInvoiceTotals(data: Record<string, unknown>, t: InvoiceTotals, cols: InvoiceColumnMap) {
  if (cols.taxable) data[cols.taxable] = t.taxable;
  if (cols.gst) data[cols.gst] = t.gst;
  data.cgst_amount = t.cgst;
  data.sgst_amount = t.sgst;
  data.igst_amount = t.igst;
  data.tds_amount = t.tds;
  data.tcs_amount = t.tcs;
  data[cols.net] = t.net;
  if (data.other_charges !== undefined) data.other_charges = Math.abs(n(data.other_charges));
  if (data.other_charges_sign !== undefined) data.other_charges_sign = n(data.other_charges_sign) < 0 ? -1 : 1;
}

/**
 * All summary header columns for a raw-SQL write (dedicated GRN routes):
 * the user-entered heads from the body plus the computed amounts.
 */
export function invoiceSummaryColumns(body: Record<string, any>, t: InvoiceTotals, tcsPctKey = 'tcs_pct'): Record<string, unknown> {
  const c = chargesFromRow(body, tcsPctKey);
  const str = (v: unknown, max: number) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
  return {
    freight_charges: n(c.freight_charges),
    insurance: n(c.insurance),
    customs_duty: n(c.customs_duty),
    clearing_charges: n(c.clearing_charges),
    other_charges: n(c.other_charges),
    other_charges_sign: c.other_charges_sign,
    other_charges_label: str(body.other_charges_label, 80),
    tds_section: str(body.tds_section, 30),
    tds_pct: n(c.tds_pct),
    tds_amount: t.tds,
    tcs_section: str(body.tcs_section, 30),
    [tcsPctKey]: n(c.tcs_pct),
    tcs_amount: t.tcs,
    round_off: t.roundOff,
    cgst_amount: t.cgst,
    sgst_amount: t.sgst,
    igst_amount: t.igst,
  };
}
