import type { Request } from 'express';
import { execute, txExecute, type Tx } from '../config/db.js';

type Action = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Write to the universal audit trail. Never throws — an audit failure must not
 * abort the business transaction that triggered it.
 */
export async function audit(
  req: Request,
  table: string,
  recordId: number,
  action: Action,
  oldValues?: unknown,
  newValues?: unknown,
  tx?: Tx,
): Promise<void> {
  const sql = `INSERT INTO log_audit
      (company_id, table_name, record_id, action, old_values, new_values, changed_by, ip_address)
      VALUES (?,?,?,?,?,?,?,?)`;
  const params = [
    req.user?.companyId ?? null,
    table,
    recordId,
    action,
    oldValues === undefined ? null : JSON.stringify(oldValues),
    newValues === undefined ? null : JSON.stringify(newValues),
    req.user?.id ?? null,
    req.ip ?? null,
  ];
  try {
    if (tx) await txExecute(tx, sql, params);
    else await execute(sql, params);
  } catch (err) {
    console.error('[audit] failed to record audit entry:', (err as Error).message);
  }
}
