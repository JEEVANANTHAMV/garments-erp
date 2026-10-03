import { txExecute, type Tx } from '../config/db.js';

/**
 * PO receipt status (client voice note 03-Oct-2026): derived from the PO lines on every read, so returns /
 * cancellations never leave it stale.
 *   PENDING            nothing received
 *   PARTIALLY_RECEIVED some received, some still to come
 *   FULLY_RECEIVED     every line received in full
 *   SHORT_CLOSED       every line done, at least one closed short by a FINAL GRN
 */
const statusSql = (lineTable: string, qtyCol: string, poRef: string) => `(SELECT CASE
    WHEN COUNT(*) = 0 THEN 'PENDING'
    WHEN SUM(CASE WHEN COALESCE(l.received_qty, 0) + 0.0005 >= l.${qtyCol} OR l.short_closed = 1 THEN 0 ELSE 1 END) = 0
      THEN IF(SUM(l.short_closed) > 0, 'SHORT_CLOSED', 'FULLY_RECEIVED')
    WHEN SUM(COALESCE(l.received_qty, 0)) > 0 THEN 'PARTIALLY_RECEIVED' ELSE 'PENDING' END
    FROM ${lineTable} l WHERE l.po_id = ${poRef})`;
export const PO_RECEIPT_STATUS_SQL = (poRef = 't.id') => statusSql('trx_purchase_order_line', 'qty', poRef);
export const TRIM_PO_RECEIPT_STATUS_SQL = (poRef = 't.id') => statusSql('trx_trim_po_line', 'order_qty', poRef);

/** A FINAL GRN closes the PO lines it received on — whatever is still pending on them will not come. */
export async function closePoLinesShort(tx: Tx, kind: 'PO' | 'TRIM_PO', lineIds: number[], grnId: number) {
  const ids = [...new Set(lineIds.filter(Boolean).map(Number))];
  if (!ids.length) return;
  const [tbl, qty] = kind === 'PO' ? ['trx_purchase_order_line', 'qty'] : ['trx_trim_po_line', 'order_qty'];
  await txExecute(tx, `UPDATE ${tbl} SET short_closed = 1, short_closed_grn_id = ? WHERE id IN (?) AND COALESCE(received_qty, 0) + 0.0005 < ${qty}`, [grnId, ids]);
}
