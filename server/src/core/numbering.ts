import { txQueryOne, txExecute, type Tx } from '../config/db.js';

/**
 * Generate the next document number for a doc type, atomically.
 *
 * MUST be called inside a transaction: the series row is locked FOR UPDATE so
 * two concurrent documents can never take the same number.
 */
export async function nextDocNumber(
  tx: Tx,
  companyId: number,
  docType: string,
  opts: { branchId?: number | null; fyId?: number | null } = {},
): Promise<string> {
  const branchId = opts.branchId ?? null;
  const fyId = opts.fyId ?? null;

  const row = await txQueryOne<{
    id: number; prefix: string; suffix: string; next_number: number; padding: number;
  }>(
    tx,
    `SELECT id, prefix, suffix, next_number, padding
       FROM cfg_number_series
      WHERE company_id = ?
        AND (branch_id <=> ?)
        AND doc_type = ?
        AND (fy_id <=> ?)
      LIMIT 1
      FOR UPDATE`,
    [companyId, branchId, docType, fyId],
  );

  if (row) {
    const num = String(row.next_number).padStart(row.padding, '0');
    await txExecute(tx, `UPDATE cfg_number_series SET next_number = next_number + 1 WHERE id = ?`, [row.id]);
    return `${row.prefix ?? ''}${num}${row.suffix ?? ''}`;
  }

  // No series configured — create one on demand so the document still gets a
  // sane, sequential number rather than failing.
  const prefix = `${docType.split('_').map((w) => w[0]).join('')}-`;
  await txExecute(
    tx,
    `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
     VALUES (?,?,?,?,?,2,5)`,
    [companyId, branchId, docType, fyId, prefix],
  );
  return `${prefix}00001`;
}
