import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, txQuery, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

/**
 * Quotation versions (client voice note 30-Sep-2026): a saved quotation that is edited
 * again keeps what it was as V1, V2 … Every save that changes the header or the lines
 * snapshots the stored quotation (header + lines) as its current version number and
 * moves the quotation to the next version. A save without changes keeps the version.
 */

/** Header columns that are not content (never make a new version on their own). */
const NOT_CONTENT = new Set(['version', 'updated_by', 'updated_at', 'created_by', 'created_at', 'quotation_no']);
const LINE_KEYS = [
  'job_no', 'so_id', 'bom_line_id', 'material_type', 'fabric_id', 'yarn_id', 'trim_id', 'style_id', 'color_id', 'size_id',
  'dia', 'gsm', 'yarn_type', 'yarn_count', 'trim_size', 'description', 'qty', 'uom_id', 'unit_price',
  'quotation_rate', 'confirm_rate', 'gst_rate', 'igst_rate', 'amount',
];

/** Comparable form of a value: numbers as numbers (420 == "420.0000"), blanks as null. */
const norm = (v: unknown) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (typeof v !== 'object' && String(v).trim() !== '' && Number.isFinite(n)) return Math.round(n * 10000) / 10000;
  return String(v).slice(0, 10) === String(v) ? String(v) : String(v).trim();
};
const pick = (row: any, keys: string[]) => keys.map((k) => norm(row?.[k]));

/** crud beforeUpdateTx hook for quotations. */
export async function quotationBeforeUpdateTx(req: Request, id: number, before: any, data: Record<string, unknown>, tx: Tx) {
  delete data.version;                                   // the version is the server's, never the page's
  const oldLines = await txQuery<any>(tx, 'SELECT * FROM trx_quotation_line WHERE quotation_id = ? ORDER BY sort_order, id', [id]);
  const newLines: any[] | null = Array.isArray(req.body?.lines) ? req.body.lines : null;
  const headerChanged = Object.keys(data).some((k) => !NOT_CONTENT.has(k) && k in before && JSON.stringify(norm(data[k])) !== JSON.stringify(norm(before[k])));
  const linesChanged = newLines !== null && JSON.stringify(oldLines.map((l) => pick(l, LINE_KEYS))) !== JSON.stringify(newLines.map((l) => pick(l, LINE_KEYS)));
  if (!headerChanged && !linesChanged) return;
  const cur = Number(before.version) || 1;
  await txExecute(tx,
    `INSERT INTO trx_quotation_version (company_id, quotation_id, version, header_json, lines_json, total_amount, changed_by)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE header_json = VALUES(header_json), lines_json = VALUES(lines_json),
                             total_amount = VALUES(total_amount), changed_by = VALUES(changed_by), changed_at = CURRENT_TIMESTAMP`,
    [before.company_id, id, cur, JSON.stringify(before), JSON.stringify(oldLines), Number(before.total_amount) || 0, req.user!.id]);
  data.version = cur + 1;
}

export const quotationVersionsRouter = Router();

/** GET /quotations/:id/versions — V1 … Vn (earlier versions + the current one). */
quotationVersionsRouter.get('/quotations/:id/versions', requirePermission('QUOTATION.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const q = await queryOne<any>(
    `SELECT t.id, t.quotation_no, t.version, t.total_amount, COALESCE(t.updated_at, t.created_at) AS changed_at, u.full_name AS changed_by_name
       FROM trx_quotation t LEFT JOIN mst_user u ON u.id = COALESCE(t.updated_by, t.created_by)
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!q) throw NotFound('Quotation not found');
  const rows = await query<any>(
    `SELECT v.version, v.total_amount, v.changed_at, u.full_name AS saved_by_name, JSON_LENGTH(v.lines_json) AS line_count
       FROM trx_quotation_version v LEFT JOIN mst_user u ON u.id = v.changed_by
      WHERE v.quotation_id = ? AND v.company_id = ? ORDER BY v.version`, [id, req.user!.companyId]);
  res.json({
    data: {
      quotation_no: q.quotation_no, current_version: Number(q.version) || 1,
      versions: [
        ...rows.map((r) => ({ version: Number(r.version), total_amount: Number(r.total_amount), replaced_at: r.changed_at, replaced_by: r.saved_by_name, line_count: Number(r.line_count) || 0, current: false })),
        { version: Number(q.version) || 1, total_amount: Number(q.total_amount), replaced_at: null, replaced_by: null, saved_at: q.changed_at, saved_by: q.changed_by_name, current: true },
      ],
    },
  });
}));

/** GET /quotations/:id/versions/:v — the stored snapshot of an earlier version (header + lines). */
quotationVersionsRouter.get('/quotations/:id/versions/:v', requirePermission('QUOTATION.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const v = z.coerce.number().int().positive().parse(req.params.v);
  const row = await queryOne<any>(
    'SELECT header_json, lines_json, changed_at FROM trx_quotation_version WHERE quotation_id = ? AND version = ? AND company_id = ?',
    [id, v, req.user!.companyId]);
  if (!row) throw NotFound(`Version V${v} not found`);
  const parse = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x);
  res.json({ data: { version: v, replaced_at: row.changed_at, header: parse(row.header_json), lines: parse(row.lines_json) } });
}));
