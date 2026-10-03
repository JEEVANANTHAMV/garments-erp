import { z } from 'zod';
import { txExecute, type Tx } from '../config/db.js';
import { BadRequest } from './errors.js';
import { computeInvoice, type GstMode, type InvoiceTotals } from './invoiceCalc.js';
import { useGateEntry } from './inwardControls.js';

/**
 * Job-work bills (knitting, fabric process, yarn process) work like the purchase bill (client voice note 03-Oct-2026):
 * party bill no + date, due date, gate entry, GST nature (CGST + SGST / IGST), freight, other charges (± with label),
 * TDS, TCS and round off — computed by the common invoice calculation (core/invoiceCalc.ts) so the totals match the
 * Bills Inward screen. Taxable = GRN charges + billable reprocess − recovery − discount − debit.
 */
const money = z.coerce.number().min(0).default(0);
export const processBillHeadSchema = {
  party_bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  gate_inward_id: z.coerce.number().int().positive().nullish(),
  gst_type: z.enum(['INTRA_STATE', 'INTER_STATE']).default('INTRA_STATE'),
  debit_amount: money,
  freight_charges: money,
  other_charges: z.coerce.number().default(0),
  other_charges_sign: z.coerce.number().default(1),
  other_charges_label: z.string().trim().max(80).nullish(),
  tds_section: z.string().trim().max(20).nullish(),
  tds_pct: z.coerce.number().min(0).max(30).default(0),
  tcs_section: z.string().trim().max(20).nullish(),
  tcs_pct: z.coerce.number().min(0).max(5).default(0),
  round_off: z.coerce.number().min(-10).max(10).default(0),
};
const headObject = z.object(processBillHeadSchema);
type Head = z.infer<typeof headObject> & { discount_amount: number; gst_pct: number; bill_date: string };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Checks the dates and the gate entry (must be the contractor's, not cancelled) before the bill is written. */
export async function checkProcessBillHead(tx: Tx, cid: number, b: Head, vendorId: number, label: string) {
  if (b.party_bill_date && b.party_bill_date > b.bill_date) throw BadRequest(`${label}: the party bill date is after the bill date`);
  if (b.due_date && b.due_date < b.bill_date) throw BadRequest(`${label}: the due date is before the bill date`);
  return b.gate_inward_id ? useGateEntry(tx, cid, { gate_inward_id: b.gate_inward_id, party_id: vendorId, label }) : null;
}

export function processBillTotals(b: Head, gross: number, recovery: number): InvoiceTotals & { base: number } {
  const base = r2(gross - recovery - b.discount_amount - b.debit_amount);
  if (base < 0) throw BadRequest(`Recovery + discount + debit (₹${r2(recovery + b.discount_amount + b.debit_amount)}) is more than the charges (₹${r2(gross)})`);
  const t = computeInvoice([{ taxable: base, gst_rate: b.gst_pct }], b.gst_type as GstMode, {
    freight_charges: b.freight_charges, other_charges: Math.abs(b.other_charges), other_charges_sign: b.other_charges_sign < 0 || b.other_charges < 0 ? -1 : 1,
    tds_pct: b.tds_pct, tcs_pct: b.tcs_pct, round_off: b.round_off,
  });
  return { ...t, base };
}

/** Writes the header money columns of a job-work bill (gross / recovery are the caller's lines). */
export async function writeProcessBillTotals(tx: Tx, table: 'trx_fabric_process_bill' | 'trx_yarn_process_bill' | 'trx_knitting_bill', id: number, b: Head,
  gross: number, recovery: number, gateId: number | null, rateChanged: boolean) {
  const t = processBillTotals(b, gross, recovery);
  const match = rateChanged ? 'DISCREPANCY' : gateId ? 'FULLY_MATCHED' : 'PARTIAL';
  await txExecute(tx,
    `UPDATE ${table} SET gross_amount = ?, ${table === 'trx_knitting_bill' ? '' : 'recovery_amount = ?, '}discount_amount = ?, debit_amount = ?, party_bill_date = ?, due_date = ?, gate_inward_id = ?,
            gst_type = ?, taxable_amount = ?, gst_amount = ?, cgst_amount = ?, sgst_amount = ?, igst_amount = ?, freight_charges = ?, other_charges = ?, other_charges_sign = ?,
            other_charges_label = ?, tds_section = ?, tds_pct = ?, tds_amount = ?, tcs_section = ?, tcs_pct = ?, tcs_amount = ?, round_off = ?, net_amount = ?, match_status = ?, calc_version = 2
      WHERE id = ?`,
    [r2(gross), ...(table === 'trx_knitting_bill' ? [] : [r2(recovery)]), r2(b.discount_amount), r2(b.debit_amount), b.party_bill_date ?? null, b.due_date ?? null, gateId,
      b.gst_type, t.base, t.gst, t.cgst, t.sgst, t.igst, r2(b.freight_charges), Math.abs(r2(b.other_charges)), b.other_charges_sign < 0 || b.other_charges < 0 ? -1 : 1,
      b.other_charges_label || null, b.tds_section || null, b.tds_pct, t.tds, b.tcs_section || null, b.tcs_pct, t.tcs, t.roundOff, t.net, match, id]);
  return { taxable_amount: t.base, gst_amount: t.gst, cgst_amount: t.cgst, sgst_amount: t.sgst, igst_amount: t.igst, tds_amount: t.tds, tcs_amount: t.tcs, net_amount: t.net, match_status: match };
}
