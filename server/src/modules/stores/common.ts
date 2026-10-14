import type { Request } from 'express';
import { z } from 'zod';
import { queryOne } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const r4 = (x: number) => Math.round(x * 10000) / 10000;
export const cidOf = (req: Request) => req.user!.companyId;
export const uidOf = (req: Request) => req.user!.id;
export const can = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
export const todayStr = () => new Date().toISOString().slice(0, 10);

export const idOpt = z.coerce.number().int().positive().nullish().transform((v) => v ?? null);
export const strOpt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
export const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(255) });
export const idParam = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);

export const listQuery = z.object({
  from: dateStr.optional(), to: dateStr.optional(),
  status: z.string().trim().max(20).optional().transform((v) => v || undefined),
  q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

/** Date-range / status / search WHERE parts on a header alias `h` with a date column. */
export function listWhere(cid: number, q: z.infer<typeof listQuery>, dateCol: string, searchCols: string[]) {
  const where = ['h.company_id = ?']; const p: unknown[] = [cid];
  if (q.from) { where.push(`h.${dateCol} >= ?`); p.push(q.from); }
  if (q.to) { where.push(`h.${dateCol} <= ?`); p.push(q.to); }
  if (q.status) { where.push('h.status = ?'); p.push(q.status); }
  if (q.q && searchCols.length) { where.push(`(${searchCols.map((c) => `${c} LIKE ?`).join(' OR ')})`); searchCols.forEach(() => p.push(`%${q.q}%`)); }
  return { where: where.join(' AND '), params: p };
}

/** Header row of a document, locked, scoped to the company. */
export async function mustGet<T = any>(table: string, cid: number, id: number, label: string): Promise<T> {
  const row = await queryOne<T>(`SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!row) throw NotFound(`${label} not found`);
  return row;
}

export function needStatus(row: { status: string; doc_no?: string }, allowed: string[], action: string) {
  if (!allowed.includes(row.status)) {
    throw BadRequest(`${row.doc_no ?? 'Document'} is ${row.status.replace(/_/g, ' ').toLowerCase()} — it cannot be ${action}. Posted documents are never edited or deleted; cancel a draft with a reason instead.`);
  }
}

/** SO-derived report columns: job no, style, season, buyer, buyer dept (buyer category), order type. */
export const SO_COLS = `COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, so.season, so.order_type, buyer.party_name buyer, buyer.buyer_category buyer_dept`;
export const soJoins = (soExpr: string) => `LEFT JOIN trx_sales_order so ON so.id = ${soExpr} LEFT JOIN mst_party buyer ON buyer.id = so.buyer_id`;
/** Item name of a line with yarn / fabric / trim ids or a description. */
export const ITEM_NAME = `COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, l.item_description)`;
export const ITEM_TYPE = `CASE l.material_type WHEN 'YARN' THEN COALESCE(y.yarn_type, 'Yarn') WHEN 'FABRIC' THEN COALESCE(fb.fabric_type, 'Fabric') WHEN 'TRIM' THEN tr.trim_type ELSE 'General' END`;
export const ITEM_JOINS = `LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id LEFT JOIN mst_trim tr ON tr.id = l.trim_id LEFT JOIN cfg_uom u ON u.id = l.uom_id`;

/** Style of a job (first SO line) when the user picked only the job. */
export async function styleOfSo(soId: number | null | undefined) {
  if (!soId) return null;
  const r = await queryOne<any>('SELECT style_id FROM trx_sales_order_line WHERE so_id = ? AND style_id IS NOT NULL ORDER BY id LIMIT 1', [soId]);
  return r?.style_id ? Number(r.style_id) : null;
}
