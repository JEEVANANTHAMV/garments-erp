import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { jobPurchaseStatus, excessSettings } from '../../core/purchaseExcess.js';
import { n, r2, r4, cidOf, uidOf, todayStr, idOpt, strOpt, dateStr, reasonSchema, idParam, listQuery, listWhere, mustGet, needStatus, styleOfSo } from './common.js';

/**
 * Special requests (client tracker 14-Oct-2026). The bill tracker moved to billTracker.routes.ts.
 *   /stores/special-requests     purchase over and above the budget: entry → approve / reject
 *   GET /stores/reports/special-requests
 */
export const billSpecialRouter = Router();

// Bill tracker: billTracker.routes.ts (document inward, links, matching, custody, approval, posting — 24-Oct-2026).

// ================================================================== SPECIAL REQUEST
const SR_VIEW = requireAny('PURCHASE.VIEW', 'BOM.VIEW', 'INVENTORY.VIEW');
const SR_CREATE = requireAny('PURCHASE.CREATE', 'PURCHASE.APPROVE');
const SR_APPROVE = requirePermission('PURCHASE.APPROVE');
const GROUP: Record<string, 'YARN' | 'FABRIC' | 'TRIM' | null> = { YARN: 'YARN', FABRIC: 'FABRIC', TRIM: 'TRIM', GENERAL: null };

/** BOM requirement / allowed / ordered for the item on the job — the "budget". */
async function budgetOf(cid: number, soId: number | null, mt: string, itemId: number | null) {
  if (!soId || !itemId || !GROUP[mt]) return null;
  const st = await jobPurchaseStatus(cid, soId);
  const key = `${mt[0]}:${itemId}`;
  const row = st.rows.find((r: any) => r.key === key);
  return row ? { required: row.required, allowed: row.allowed, ordered: row.ordered, balance: row.balance, uom_code: row.uom_code, uom_id: row.uom_id, job_no: st.job_no } : { required: 0, allowed: 0, ordered: 0, balance: 0, job_no: st.job_no, not_on_bom: true };
}

billSpecialRouter.get('/special-requests/budget', SR_VIEW, ah(async (req, res) => {
  const q = z.object({ so_id: z.coerce.number().int().positive(), material_type: z.enum(['YARN', 'FABRIC', 'TRIM', 'GENERAL']), item_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  res.json({ data: await budgetOf(cidOf(req), q.so_id, q.material_type, q.item_id ?? null) });
}));

const srSchema = z.object({
  req_date: dateStr.default(todayStr), so_id: idOpt, style_id: idOpt, material_type: z.enum(['YARN', 'FABRIC', 'TRIM', 'GENERAL']),
  yarn_id: idOpt, fabric_id: idOpt, trim_id: idOpt, item_description: strOpt(255), uom_id: idOpt,
  requested_qty: z.coerce.number().positive('Qty must be more than zero'), rate: z.coerce.number().min(0).default(0),
  reason: z.string().trim().min(3, 'Give the reason for the extra purchase').max(500), raise_allowance: z.coerce.boolean().default(true),
}).superRefine((b, ctx) => {
  const need = { YARN: b.yarn_id, FABRIC: b.fabric_id, TRIM: b.trim_id, GENERAL: b.item_description }[b.material_type];
  if (!need) ctx.addIssue({ code: 'custom', message: b.material_type === 'GENERAL' ? 'Enter the item' : `Select the ${b.material_type.toLowerCase()}` });
});

const srSql = (where: string) =>
  `SELECT r.*, COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, r.item_description) item_name, u.code uom_code,
          COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code, buyer.party_name buyer, uc.full_name requested_by, ud.full_name decided_by_name
     FROM trx_special_request r LEFT JOIN mst_yarn y ON y.id = r.yarn_id LEFT JOIN mst_fabric fb ON fb.id = r.fabric_id LEFT JOIN mst_trim tr ON tr.id = r.trim_id
     LEFT JOIN cfg_uom u ON u.id = r.uom_id LEFT JOIN trx_sales_order so ON so.id = r.so_id LEFT JOIN mst_party buyer ON buyer.id = so.buyer_id
     LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_user uc ON uc.id = r.created_by LEFT JOIN mst_user ud ON ud.id = r.decided_by
    WHERE ${where}`;
const srRow = (cid: number, id: number) => queryOne<any>(srSql('r.id = ? AND r.company_id = ?'), [id, cid]);

billSpecialRouter.get('/special-requests', SR_VIEW, ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), q, 'req_date', ['h.req_no', 'h.reason', 'so.io_no', 'so.so_no']);
  res.json({ data: await query<any>(srSql(w.where.replace(/\bh\./g, 'r.')) + ` ORDER BY r.req_date DESC, r.id DESC LIMIT ${q.limit}`, w.params) });
}));

billSpecialRouter.get('/special-requests/:id', SR_VIEW, ah(async (req, res) => {
  const r = await srRow(cidOf(req), idParam(req));
  if (!r) throw BadRequest('Special request not found');
  res.json({ data: r });
}));

billSpecialRouter.post('/special-requests', SR_CREATE, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = srSchema.parse(req.body);
  const itemId = b.yarn_id ?? b.fabric_id ?? b.trim_id ?? null;
  const bud = await budgetOf(cid, b.so_id, b.material_type, itemId);
  const uomId = b.uom_id ?? (bud as any)?.uom_id ?? null;
  const id = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'SPECIAL_REQUEST');
    const r = await txExecute(tx,
      `INSERT INTO trx_special_request (company_id, req_no, req_date, so_id, style_id, material_type, yarn_id, fabric_id, trim_id, item_description, uom_id,
                                        budget_qty, ordered_qty, requested_qty, rate, amount, reason, raise_allowance, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.req_date, b.so_id, b.style_id ?? (await styleOfSo(b.so_id)), b.material_type, b.material_type === 'YARN' ? b.yarn_id : null,
       b.material_type === 'FABRIC' ? b.fabric_id : null, b.material_type === 'TRIM' ? b.trim_id : null, b.item_description, uomId,
       n(bud?.allowed), n(bud?.ordered), b.requested_qty, b.rate, r2(b.requested_qty * b.rate), b.reason, b.raise_allowance && !!b.so_id && !!GROUP[b.material_type] ? 1 : 0, uidOf(req)]);
    return r.insertId as number;
  });
  const row = await srRow(cid, id);
  await audit(req, 'trx_special_request', id, 'INSERT', undefined, row);
  res.status(201).json({ data: row, message: `${row.req_no} raised — awaiting approval` });
}));

/**
 * Approval. With raise_allowance (job + yarn / fabric / trim) the job's purchase excess allowance for that material
 * group grows by the requested qty, so the PO for the extra quantity passes the purchase excess check.
 */
billSpecialRouter.post('/special-requests/:id/approve', SR_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { remarks } = z.object({ remarks: strOpt(255) }).parse(req.body ?? {});
  const r = await mustGet<any>('trx_special_request', cid, id, 'Special request');
  needStatus({ ...r, doc_no: r.req_no }, ['PENDING'], 'approved');
  let applied: number | null = null;
  await transaction(async (tx) => {
    const lock = await txQueryOne<any>(tx, 'SELECT status FROM trx_special_request WHERE id = ? FOR UPDATE', [id]);
    needStatus({ ...lock, doc_no: r.req_no }, ['PENDING'], 'approved');
    const grp = GROUP[r.material_type];
    if (r.raise_allowance && r.so_id && grp) {
      const cur = await txQueryOne<any>(tx, 'SELECT * FROM trx_job_purchase_allowance WHERE company_id = ? AND so_id = ? AND material_type = ? FOR UPDATE', [cid, r.so_id, grp]);
      const def = (await excessSettings(cid)).defaults[grp];
      const base = cur ? { pct: n(cur.excess_pct), qty: n(cur.excess_qty) } : def;
      applied = n(r.requested_qty);
      await txExecute(tx,
        `INSERT INTO trx_job_purchase_allowance (company_id, so_id, material_type, excess_pct, excess_qty, remarks, updated_by) VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE excess_qty = VALUES(excess_qty), remarks = VALUES(remarks), updated_by = VALUES(updated_by)`,
        [cid, r.so_id, grp, base.pct, r4(base.qty + applied), `Special request ${r.req_no} +${applied}`.slice(0, 255), uidOf(req)]);
    }
    await txExecute(tx, `UPDATE trx_special_request SET status = 'APPROVED', decided_by = ?, decided_at = NOW(), decision_remarks = ?, allowance_applied_qty = ? WHERE id = ?`,
      [uidOf(req), remarks, applied, id]);
  });
  await audit(req, 'trx_special_request', id, 'UPDATE', { status: 'PENDING' }, { status: 'APPROVED', allowance_applied_qty: applied, remarks });
  res.json({ data: await srRow(cid, id), message: `${r.req_no} approved${applied ? ` — job allowance raised by ${applied}` : ''}` });
}));

billSpecialRouter.post('/special-requests/:id/reject', SR_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const r = await mustGet<any>('trx_special_request', cid, id, 'Special request');
  needStatus({ ...r, doc_no: r.req_no }, ['PENDING'], 'rejected');
  await query(`UPDATE trx_special_request SET status = 'REJECTED', decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?`, [uidOf(req), reason, id]);
  await audit(req, 'trx_special_request', id, 'UPDATE', { status: 'PENDING' }, { status: 'REJECTED', reason });
  res.json({ data: await srRow(cid, id), message: `${r.req_no} rejected` });
}));

billSpecialRouter.post('/special-requests/:id/cancel', SR_CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const r = await mustGet<any>('trx_special_request', cid, id, 'Special request');
  needStatus({ ...r, doc_no: r.req_no }, ['PENDING'], 'cancelled');
  await query(`UPDATE trx_special_request SET status = 'CANCELLED', decided_by = ?, decided_at = NOW(), decision_remarks = ? WHERE id = ?`, [uidOf(req), reason, id]);
  await audit(req, 'trx_special_request', id, 'UPDATE', { status: 'PENDING' }, { status: 'CANCELLED', reason });
  res.json({ data: await srRow(cid, id), message: `${r.req_no} cancelled` });
}));

billSpecialRouter.get('/reports/special-requests', requireAny('PURCHASE.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), q, 'req_date', ['h.req_no', 'h.reason', 'h.item_description', 'so.io_no', 'so.so_no']);
  res.json({ data: await query<any>(srSql(w.where.replace(/\bh\./g, 'r.')) + ' ORDER BY r.req_date, r.id LIMIT 5000', w.params) });
}));
