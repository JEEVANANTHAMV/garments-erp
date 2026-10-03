import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { excessSettings, jobPurchaseStatus } from '../../core/purchaseExcess.js';

/**
 * Purchase Excess Limits (client voice note 03-Oct-2026):
 *   GET/PUT /purchase-excess/settings       control (BLOCK / WARN / OFF) + default % / qty per material
 *   GET     /jobs/:soId/purchase-status     per BOM item: requirement, ordered, allowed, balance, over
 *   PUT     /jobs/:soId/purchase-allowance  the job's own allowance per material (blank = company default)
 */
export const purchaseExcessRouter = Router();
const VIEW = requireAny('PURCHASE.VIEW', 'PROCUREMENT.VIEW', 'BOM.VIEW');
const EDIT = requireAny('PURCHASE.APPROVE', 'SETTINGS.UPDATE');

purchaseExcessRouter.get('/purchase-excess/settings', VIEW, ah(async (req, res) => {
  res.json({ data: await excessSettings(req.user!.companyId) });
}));

const lim = z.object({ pct: z.coerce.number().min(0).max(100), qty: z.coerce.number().min(0).max(1_000_000) });
purchaseExcessRouter.put('/purchase-excess/settings', EDIT, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ control: z.enum(['BLOCK', 'WARN', 'OFF']), defaults: z.object({ YARN: lim, FABRIC: lim, TRIM: lim }) }).parse(req.body);
  const before = await excessSettings(cid);
  const set = async (k: string, v: string) => execute(
    `INSERT INTO cfg_system_setting (company_id, setting_key, setting_value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [cid, k, v]);
  await set('PURCHASE_EXCESS_CONTROL', b.control);
  for (const g of ['YARN', 'FABRIC', 'TRIM'] as const) {
    await set(`PURCHASE_EXCESS_${g}_PCT`, String(b.defaults[g].pct));
    await set(`PURCHASE_EXCESS_${g}_QTY`, String(b.defaults[g].qty));
  }
  await audit(req, 'cfg_system_setting', 0, 'UPDATE', before, b);
  res.json({ data: await excessSettings(cid), message: 'Purchase excess defaults saved' });
}));

purchaseExcessRouter.get('/jobs/:soId/purchase-status', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>('SELECT id FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  res.json({ data: await jobPurchaseStatus(cid, soId) });
}));

purchaseExcessRouter.put('/jobs/:soId/purchase-allowance', EDIT, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>('SELECT id, COALESCE(io_no, so_no) job FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const b = z.object({ material_type: z.enum(['YARN', 'FABRIC', 'TRIM']), use_default: z.coerce.boolean().default(false),
    excess_pct: z.coerce.number().min(0).max(100).default(0), excess_qty: z.coerce.number().min(0).max(1_000_000).default(0),
    remarks: z.string().trim().max(255).nullish() }).parse(req.body);
  const before = await query<any>('SELECT * FROM trx_job_purchase_allowance WHERE company_id = ? AND so_id = ? AND material_type = ?', [cid, soId, b.material_type]);
  if (b.use_default) await execute('DELETE FROM trx_job_purchase_allowance WHERE company_id = ? AND so_id = ? AND material_type = ?', [cid, soId, b.material_type]);
  else await execute(`INSERT INTO trx_job_purchase_allowance (company_id, so_id, material_type, excess_pct, excess_qty, remarks, updated_by) VALUES (?,?,?,?,?,?,?)
                      ON DUPLICATE KEY UPDATE excess_pct = VALUES(excess_pct), excess_qty = VALUES(excess_qty), remarks = VALUES(remarks), updated_by = VALUES(updated_by)`,
    [cid, soId, b.material_type, b.excess_pct, b.excess_qty, b.remarks ?? null, req.user!.id]);
  await audit(req, 'trx_job_purchase_allowance', soId, 'UPDATE', before[0] ?? null, b);
  res.json({ data: await jobPurchaseStatus(cid, soId), message: b.use_default ? `${so.job}: ${b.material_type.toLowerCase()} back to the company default` : `${so.job}: ${b.material_type.toLowerCase()} allowance saved` });
}));
