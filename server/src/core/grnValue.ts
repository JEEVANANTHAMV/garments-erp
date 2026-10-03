import { txExecute, type Tx } from '../config/db.js';

/**
 * Job-work inward GRNs (knitting grey inward, fabric / yarn process inward) are valued at the job-work rate of
 * the DC they come back on (the job's approved process quotation) — accepted qty × rate on each line and the
 * header totals (client voice note 03-Oct-2026: the GRN showed no rate). GST is charged on the job-work bill.
 */
export async function valueGrnAtRate(tx: Tx, grnId: number, rate: number | null | undefined) {
  const r = Number(rate) || 0;
  await txExecute(tx,
    `UPDATE trx_grn_line SET rate = ?, taxable_amount = ROUND(accepted_qty * ?, 4), total_amount = ROUND(accepted_qty * ?, 4) WHERE grn_id = ?`, [r, r, r, grnId]);
  await txExecute(tx,
    `UPDATE trx_grn g JOIN (SELECT grn_id, COALESCE(SUM(taxable_amount), 0) t FROM trx_grn_line WHERE grn_id = ? GROUP BY grn_id) x ON x.grn_id = g.id
        SET g.taxable_amount = x.t, g.net_amount = x.t, g.grand_total = x.t WHERE g.id = ?`, [grnId, grnId]);
}
