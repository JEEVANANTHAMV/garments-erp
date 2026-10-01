import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { yarnStockRows, yarnStockQuery } from '../procurement/fabricYarnProcurement.routes.js';
import { yarnJobLots, approvalHistory, postTransferLines, resolveSoId } from './jobStock.routes.js';

/**
 * Yarn substitution (Full_Knitting_Module_Developer_Document §17–§19, client voice note 02-Oct-2026):
 * the program needs 24s but the machine runs 25s (or 24s is short) — an approved alternate yarn, from an
 * active substitution rule, is issued against the original requirement. The original requirement is
 * never rewritten: the substitute KG (× conversion ratio = required-yarn KG covered) is its own record.
 * When the substitute lot belongs to another job, posting transfers it to this job (one transfer ref).
 */
export const yarnSubstitutionRouter = Router();
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const canApprove = (req: Request) => !!req.user?.isSuperAdmin || !!req.user?.permissions.has('YARN_SUBSTITUTION.APPROVE');

// =====================================================================================
// Rule master
// =====================================================================================
const ruleSchema = z.object({
  required_yarn_id: z.coerce.number().int().positive(),
  substitute_yarn_id: z.coerce.number().int().positive(),
  fabric_id: z.coerce.number().int().positive().nullish(),
  gsm_from: z.coerce.number().min(0).nullish(),
  gsm_to: z.coerce.number().min(0).nullish(),
  buyer_id: z.coerce.number().int().positive().nullish(),
  style_id: z.coerce.number().int().positive().nullish(),
  max_pct: z.coerce.number().min(0.01).max(100).default(10),
  conversion_ratio: z.coerce.number().positive().default(1),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  remarks: z.string().trim().max(255).nullish(),
  is_active: z.coerce.boolean().default(true),
}).refine((r) => r.required_yarn_id !== r.substitute_yarn_id, { message: 'The substitute must be a different yarn' })
  .refine((r) => r.gsm_from == null || r.gsm_to == null || r.gsm_from <= r.gsm_to, { message: 'GSM from cannot be more than GSM to' });
const RULE_SELECT = `SELECT r.*, ry.yarn_name required_yarn, sy.yarn_name substitute_yarn, fb.fabric_name, b.party_name buyer_name, st.style_code
                       FROM mst_yarn_substitution_rule r JOIN mst_yarn ry ON ry.id = r.required_yarn_id JOIN mst_yarn sy ON sy.id = r.substitute_yarn_id
                       LEFT JOIN mst_fabric fb ON fb.id = r.fabric_id LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN mst_style st ON st.id = r.style_id`;
yarnSubstitutionRouter.get('/yarn-substitution-rules', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  res.json({ data: await query<any>(`${RULE_SELECT} WHERE r.company_id = ? ORDER BY r.is_active DESC, ry.yarn_name, r.id`, [req.user!.companyId]) });
}));
yarnSubstitutionRouter.post('/yarn-substitution-rules', requireAny('YARN_SUBSTITUTION.APPROVE'), ah(async (req, res) => {
  const b = ruleSchema.parse(req.body);
  const r = await query<any>(`INSERT INTO mst_yarn_substitution_rule (company_id, required_yarn_id, substitute_yarn_id, fabric_id, gsm_from, gsm_to, buyer_id, style_id, max_pct,
      conversion_ratio, effective_from, effective_to, remarks, is_active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, b.required_yarn_id, b.substitute_yarn_id, b.fabric_id ?? null, b.gsm_from ?? null, b.gsm_to ?? null, b.buyer_id ?? null, b.style_id ?? null,
     b.max_pct, b.conversion_ratio, b.effective_from ?? null, b.effective_to ?? null, b.remarks ?? null, b.is_active ? 1 : 0, req.user!.id]);
  await audit(req, 'mst_yarn_substitution_rule', Number((r as any).insertId), 'INSERT', undefined, b);
  res.status(201).json({ message: 'Substitution rule added' });
}));
yarnSubstitutionRouter.put('/yarn-substitution-rules/:id', requireAny('YARN_SUBSTITUTION.APPROVE'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const before = await queryOne<any>('SELECT * FROM mst_yarn_substitution_rule WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!before) throw NotFound('Rule not found');
  const b = ruleSchema.parse(req.body);
  await query(`UPDATE mst_yarn_substitution_rule SET required_yarn_id = ?, substitute_yarn_id = ?, fabric_id = ?, gsm_from = ?, gsm_to = ?, buyer_id = ?, style_id = ?, max_pct = ?,
                 conversion_ratio = ?, effective_from = ?, effective_to = ?, remarks = ?, is_active = ? WHERE id = ?`,
    [b.required_yarn_id, b.substitute_yarn_id, b.fabric_id ?? null, b.gsm_from ?? null, b.gsm_to ?? null, b.buyer_id ?? null, b.style_id ?? null, b.max_pct, b.conversion_ratio,
     b.effective_from ?? null, b.effective_to ?? null, b.remarks ?? null, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_yarn_substitution_rule', id, 'UPDATE', before, b);
  res.json({ message: 'Substitution rule saved' });
}));

// =====================================================================================
// Program line context: requirement, what substitution already covers, rules that apply
// =====================================================================================
async function lineContext(cid: number, programYarnId: number) {
  const l = await queryOne<any>(
    `SELECT kpy.*, kp.id program_id, kp.program_no, kp.so_id, kp.io_no, kp.style_id, kp.fabric_id, kp.gsm, kp.status program_status, y.yarn_name, st.buyer_id
       FROM trx_knitting_program_yarns kpy JOIN trx_knitting_program kp ON kp.id = kpy.program_id LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id
       LEFT JOIN mst_style st ON st.id = kp.style_id WHERE kpy.id = ? AND kp.company_id = ?`, [programYarnId, cid]);
  if (!l) throw NotFound('Knitting program yarn line not found');
  const soId = await resolveSoId(cid, l.so_id, l.io_no);
  const subs = await query<any>(
    `SELECT COALESCE(SUM(IF(status = 'POSTED', equivalent_kg, 0)), 0) posted_eq, COALESCE(SUM(IF(status IN ('PENDING_APPROVAL','APPROVED','SEND_BACK'), equivalent_kg, 0)), 0) open_eq
       FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ?`, [cid, programYarnId]);
  const required = n(l.planned_qty_kg);
  const issued = n(l.issued_qty_kg);
  const gsm = Number.parseFloat(String(l.gsm ?? '')) || null;
  const rules = await query<any>(
    `${RULE_SELECT} WHERE r.company_id = ? AND r.is_active = 1 AND r.required_yarn_id = ?
        AND (r.fabric_id IS NULL OR r.fabric_id = ?) AND (r.buyer_id IS NULL OR r.buyer_id = ?) AND (r.style_id IS NULL OR r.style_id = ?)
        AND (r.effective_from IS NULL OR r.effective_from <= CURDATE()) AND (r.effective_to IS NULL OR r.effective_to >= CURDATE())`,
    [cid, l.yarn_id, l.fabric_id ?? 0, l.buyer_id ?? 0, l.style_id ?? 0]);
  const okRules = rules.filter((r) => gsm == null || ((r.gsm_from == null || gsm >= n(r.gsm_from)) && (r.gsm_to == null || gsm <= n(r.gsm_to))));
  return { line: l, so_id: soId, required, issued, posted_eq: r3(n(subs[0]?.posted_eq)), open_eq: r3(n(subs[0]?.open_eq)),
    shortage: r3(Math.max(0, required - issued - n(subs[0]?.posted_eq))), rules: okRules };
}

/** GET /yarn-substitution/options?program_yarn_id= — the requirement, shortage, applicable rules and the substitute lots in stock. */
yarnSubstitutionRouter.get('/yarn-substitution/options', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const pyid = z.coerce.number().int().positive().parse(req.query.program_yarn_id);
  const ctx = await lineContext(cid, pyid);
  const lots: any[] = [];
  for (const r of ctx.rules) {
    const ls = await yarnJobLots(cid, { yarn_id: Number(r.substitute_yarn_id) });
    ls.forEach((x) => lots.push({ ...x, rule_id: r.id, conversion_ratio: n(r.conversion_ratio), max_pct: n(r.max_pct), own: Number(x.holder_so_id ?? 0) === Number(ctx.so_id ?? 0) }));
  }
  res.json({ data: { ...ctx, lots: lots.sort((a, b) => Number(b.own) - Number(a.own)) } });
}));

// =====================================================================================
// Requests
// =====================================================================================
const reqSchema = z.object({
  request_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  program_yarn_id: z.coerce.number().int().positive(),
  rule_id: z.coerce.number().int().positive(),
  grn_line_id: z.coerce.number().int().positive(),
  from_so_id: z.coerce.number().int().min(0).default(0),
  qty_kg: z.coerce.number().positive(),
  reason: z.string().trim().min(3, 'Give the reason').max(255),
});

/** Validates a request against its rule (max %, lot holder, KG available). */
async function validate(cid: number, b: z.infer<typeof reqSchema>, excludeId?: number) {
  const ctx = await lineContext(cid, b.program_yarn_id);
  if (['CANCELLED', 'COMPLETED'].includes(ctx.line.program_status)) throw BadRequest(`Program ${ctx.line.program_no} is ${String(ctx.line.program_status).toLowerCase()}`);
  const rule = ctx.rules.find((r) => Number(r.id) === b.rule_id);
  if (!rule) throw BadRequest(`No active substitution rule allows that yarn for ${ctx.line.yarn_name} on this program (fabric / GSM / buyer / dates)`);
  const eq = r3(b.qty_kg * n(rule.conversion_ratio));
  const other = excludeId ? n((await queryOne<any>(`SELECT COALESCE(SUM(equivalent_kg), 0) q FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ? AND id = ? AND status IN ('PENDING_APPROVAL','APPROVED','POSTED','SEND_BACK')`, [cid, b.program_yarn_id, excludeId]))?.q) : 0;
  const cap = r3(ctx.required * n(rule.max_pct) / 100);
  const used = r3(ctx.posted_eq + ctx.open_eq - other);
  if (used + eq > cap + 0.0005) throw BadRequest(`Substitution is limited to ${n(rule.max_pct)}% of the ${ctx.required} KG requirement (${cap} KG); ${used} KG is already substituted / requested — at most ${r3(Math.max(0, cap - used))} KG more`);
  const lots = await yarnJobLots(cid, { grn_line_ids: [b.grn_line_id] });
  const lot = lots.find((x) => Number(x.holder_so_id ?? 0) === b.from_so_id);
  if (!lot) throw BadRequest('The substitute lot has no stock for that holder (job / general)');
  if (Number(lot.yarn_id) !== Number(rule.substitute_yarn_id)) throw BadRequest(`Lot ${lot.lot_no} is not ${rule.substitute_yarn}`);
  if (b.qty_kg > lot.available_kg + 0.0005) throw BadRequest(`Lot ${lot.lot_no}: only ${lot.available_kg} KG held by ${lot.holder_job}`);
  return { ctx, rule, eq, lot };
}

/** Posts an approved request: moves the lot to the program's job when another job holds it. */
async function postRequest(tx: Tx, req: Request, s: any) {
  const cid = req.user!.companyId;
  const b = { request_date: String(s.request_date).slice(0, 10), program_yarn_id: Number(s.program_yarn_id), rule_id: Number(s.rule_id), grn_line_id: Number(s.grn_line_id),
    from_so_id: Number(s.from_so_id) || 0, qty_kg: n(s.qty_kg), reason: s.reason };
  const v = await validate(cid, b, Number(s.id));
  const toSo = Number(v.ctx.so_id) || 0;
  let transferId: number | null = null;
  if (b.from_so_id !== toSo && toSo) {
    // the substitute lot belongs to another job (or general) — one transfer moves it to this job
    const no = await nextDocNumber(tx, cid, 'JOB_TRANSFER');
    const t = await txExecute(tx,
      `INSERT INTO trx_job_transfer (company_id, transfer_no, transfer_date, material_type, from_so_id, to_so_id, reason, created_by, status, approved_by, approved_at, posted_at, lines_json)
       VALUES (?,?,?,?,?,?,?,?, 'POSTED', ?, NOW(), NOW(), ?)`,
      [cid, no, b.request_date, 'YARN', b.from_so_id || null, toSo, `Yarn substitution ${s.request_no}: ${b.reason}`, req.user!.id, req.user!.id, JSON.stringify([{ ref_id: b.grn_line_id, qty: b.qty_kg }])]);
    transferId = Number(t.insertId);
    const jn = async (id: number) => id ? (await txQueryOne<any>(tx, 'SELECT COALESCE(io_no, so_no) j FROM trx_sales_order WHERE id = ?', [id]))?.j : 'GENERAL';
    await postTransferLines(tx, req, transferId, no, { material_type: 'YARN', transfer_date: b.request_date, from_so_id: b.from_so_id, to_so_id: toSo, to_style_id: null,
      reason: `Yarn substitution ${s.request_no}`, lines: [{ ref_id: b.grn_line_id, qty: b.qty_kg }] }, await jn(b.from_so_id), await jn(toSo));
  }
  await txExecute(tx, `UPDATE trx_yarn_substitution SET status = 'POSTED', posted_at = NOW(), transfer_id = ?, equivalent_kg = ?, conversion_ratio = ? WHERE id = ?`,
    [transferId, v.eq, n(v.rule.conversion_ratio), s.id]);
  return { transfer_id: transferId };
}

const SUB_SELECT = `SELECT s.*, kp.program_no, COALESCE(so.io_no, so.so_no, kp.io_no) io_no, ry.yarn_name required_yarn, sy.yarn_name substitute_yarn, gl.lot_no, g.grn_no,
                           COALESCE(f.io_no, f.so_no, 'GENERAL') from_job, jt.transfer_no, u.full_name requested_by, a.full_name approved_by_name
                      FROM trx_yarn_substitution s JOIN trx_knitting_program kp ON kp.id = s.program_id
                      LEFT JOIN trx_sales_order so ON so.id = s.so_id LEFT JOIN mst_yarn ry ON ry.id = s.required_yarn_id LEFT JOIN mst_yarn sy ON sy.id = s.substitute_yarn_id
                      LEFT JOIN trx_grn_line gl ON gl.id = s.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN trx_sales_order f ON f.id = s.from_so_id
                      LEFT JOIN trx_job_transfer jt ON jt.id = s.transfer_id LEFT JOIN mst_user u ON u.id = s.created_by LEFT JOIN mst_user a ON a.id = s.approved_by`;
yarnSubstitutionRouter.get('/yarn-substitution-requests', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const q = z.object({ program_id: z.coerce.number().int().optional(), status: z.string().optional() }).parse(req.query);
  const w = ['s.company_id = ?']; const p: unknown[] = [req.user!.companyId];
  if (q.program_id) { w.push('s.program_id = ?'); p.push(q.program_id); }
  if (q.status) { w.push('s.status = ?'); p.push(q.status); }
  res.json({ data: await query<any>(`${SUB_SELECT} WHERE ${w.join(' AND ')} ORDER BY s.id DESC LIMIT 500`, p) });
}));
yarnSubstitutionRouter.get('/yarn-substitution-requests/:id', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const s = await queryOne<any>(`${SUB_SELECT} WHERE s.id = ? AND s.company_id = ?`, [id, req.user!.companyId]);
  if (!s) throw NotFound('Substitution request not found');
  const history = await query<any>(`SELECT h.*, u.full_name user_name FROM trx_yarn_approval_history h LEFT JOIN mst_user u ON u.id = h.user_id WHERE h.doc_type = 'SUBSTITUTION' AND h.doc_id = ? ORDER BY h.id`, [id]);
  res.json({ data: { ...s, history } });
}));

/** POST /yarn-substitution-requests — raise a request (approvers' requests post at once). */
yarnSubstitutionRouter.post('/yarn-substitution-requests', requireAny('YARN_SUBSTITUTION.CREATE', 'YARN_SUBSTITUTION.APPROVE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = reqSchema.parse(req.body);
  const v = await validate(cid, b);
  const approver = canApprove(req);
  const out = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'YARN_SUBSTITUTION');
    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_substitution (company_id, request_no, request_date, so_id, program_id, program_yarn_id, required_yarn_id, substitute_yarn_id, rule_id, grn_line_id, from_so_id,
         qty_kg, conversion_ratio, equivalent_kg, reason, status, created_by, approved_by, approved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.request_date, v.ctx.so_id ?? null, v.ctx.line.program_id, b.program_yarn_id, v.ctx.line.yarn_id, v.rule.substitute_yarn_id, b.rule_id, b.grn_line_id, b.from_so_id || null,
       r3(b.qty_kg), n(v.rule.conversion_ratio), v.eq, b.reason, approver ? 'APPROVED' : 'PENDING_APPROVAL', req.user!.id, approver ? req.user!.id : null, approver ? new Date() : null]);
    const id = Number(r.insertId);
    await approvalHistory(tx, req, { doc_type: 'SUBSTITUTION', doc_id: id, action: 'SUBMIT', to: approver ? 'APPROVED' : 'PENDING_APPROVAL', remarks: b.reason });
    let posted = null;
    if (approver) {
      posted = await postRequest(tx, req, { id, request_no: no, ...b });
      await approvalHistory(tx, req, { doc_type: 'SUBSTITUTION', doc_id: id, action: 'POST', from: 'APPROVED', to: 'POSTED' });
    }
    return { id, request_no: no, status: approver ? 'POSTED' : 'PENDING_APPROVAL', equivalent_kg: v.eq, transfer_id: posted?.transfer_id ?? null };
  });
  await audit(req, 'trx_yarn_substitution', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.request_no} ${out.status === 'POSTED' ? `approved and posted — ${b.qty_kg} KG ${v.rule.substitute_yarn} for ${v.ctx.line.yarn_name}` : 'sent for approval'}` });
}));

/** POST /yarn-substitution-requests/:id/approve | reject | send-back | cancel */
yarnSubstitutionRouter.post('/yarn-substitution-requests/:id/:action', requireAny('YARN_SUBSTITUTION.CREATE', 'YARN_SUBSTITUTION.APPROVE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const action = z.enum(['approve', 'reject', 'send-back', 'cancel']).parse(req.params.action);
  const remarks = z.string().trim().max(255).optional().parse(req.body?.remarks);
  if (action !== 'cancel' && !canApprove(req)) throw Forbidden('Only the approver (Production Manager) can approve / reject a yarn substitution');
  const out = await transaction(async (tx) => {
    const s = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_substitution WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!s) throw NotFound('Substitution request not found');
    if (!['PENDING_APPROVAL', 'SEND_BACK'].includes(s.status)) throw BadRequest(`${s.request_no} is ${String(s.status).toLowerCase().replace('_', ' ')}`);
    if ((action === 'reject' || action === 'send-back') && (!remarks || remarks.length < 3)) throw BadRequest('Give the reason');
    if (action === 'approve') {
      if (s.status !== 'PENDING_APPROVAL') throw BadRequest(`${s.request_no} was sent back to the requester`);
      await txExecute(tx, `UPDATE trx_yarn_substitution SET status = 'APPROVED', approved_by = ?, approved_at = NOW(), decision_remarks = ? WHERE id = ?`, [req.user!.id, remarks ?? null, id]);
      await approvalHistory(tx, req, { doc_type: 'SUBSTITUTION', doc_id: id, action: 'APPROVE', from: s.status, to: 'APPROVED', remarks });
      const p = await postRequest(tx, req, s);
      await approvalHistory(tx, req, { doc_type: 'SUBSTITUTION', doc_id: id, action: 'POST', from: 'APPROVED', to: 'POSTED' });
      return { request_no: s.request_no, status: 'POSTED', transfer_id: p.transfer_id };
    }
    const to = action === 'reject' ? 'REJECTED' : action === 'send-back' ? 'SEND_BACK' : 'CANCELLED';
    await txExecute(tx, 'UPDATE trx_yarn_substitution SET status = ?, decision_remarks = ? WHERE id = ?', [to, remarks ?? null, id]);
    await approvalHistory(tx, req, { doc_type: 'SUBSTITUTION', doc_id: id, action: action.toUpperCase().replace('-', '_'), from: s.status, to, remarks });
    return { request_no: s.request_no, status: to, transfer_id: null };
  });
  await audit(req, 'trx_yarn_substitution', id, 'UPDATE', undefined, out);
  res.json({ data: out, message: `${out.request_no} ${out.status.toLowerCase().replace('_', ' ')}` });
}));

/**
 * Posted substitution KG of a program yarn line still to go out on a knitting DC for `yarnId` —
 * the knitting DC lets the substitute yarn go out against the original line up to this.
 */
export async function substituteOpen(cid: number, programYarnId: number, yarnId: number) {
  const r = await queryOne<any>(`SELECT COALESCE(SUM(qty_kg - issued_kg), 0) q FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ? AND substitute_yarn_id = ? AND status = 'POSTED'`,
    [cid, programYarnId, yarnId]);
  return r3(n(r?.q));
}
/** Books substitute KG issued on a knitting DC against the posted requests (oldest first). */
export async function bookSubstituteIssue(tx: Tx, cid: number, programYarnId: number, yarnId: number, kg: number) {
  let left = kg;
  const rows = await query<any>(`SELECT id, qty_kg - issued_kg open FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ? AND substitute_yarn_id = ? AND status = 'POSTED' AND qty_kg > issued_kg ORDER BY id`,
    [cid, programYarnId, yarnId]);
  for (const r of rows) {
    if (left <= 0.0005) break;
    const take = r3(Math.min(left, n(r.open)));
    await txExecute(tx, 'UPDATE trx_yarn_substitution SET issued_kg = issued_kg + ? WHERE id = ?', [take, r.id]);
    left = r3(left - take);
  }
}

// =====================================================================================
// Requirement grid + job yarn ledger (doc §6, §21)
// =====================================================================================
/** GET /knitting-programs/:id/yarn-requirements — required / issued / transfer in / substitute / pending per yarn line. */
yarnSubstitutionRouter.get('/knitting-programs/:id/yarn-requirements', requireAny('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const lines = await query<any>(
    `SELECT kpy.id program_yarn_id, kpy.yarn_id, y.yarn_name, kpy.count_value, kpy.colour, kpy.planned_qty_kg required_kg,
            (SELECT COALESCE(SUM(i.issued_qty_kg), 0) FROM trx_process_issue i WHERE i.src_type = 'KNITTING_PROGRAM' AND i.src_line_id = kpy.id AND i.yarn_id = kpy.yarn_id) issued_kg,
            (SELECT COALESCE(SUM(i.issued_qty_kg), 0) FROM trx_process_issue i WHERE i.src_type = 'KNITTING_PROGRAM' AND i.src_line_id = kpy.id AND i.yarn_id <> kpy.yarn_id) substitute_issued_kg,
            (SELECT COALESCE(SUM(s.qty_kg), 0) FROM trx_yarn_substitution s WHERE s.program_yarn_id = kpy.id AND s.status = 'POSTED') substitute_kg,
            (SELECT COALESCE(SUM(s.equivalent_kg), 0) FROM trx_yarn_substitution s WHERE s.program_yarn_id = kpy.id AND s.status = 'POSTED') substitute_eq_kg,
            (SELECT COALESCE(SUM(s.qty_kg), 0) FROM trx_yarn_substitution s WHERE s.program_yarn_id = kpy.id AND s.status = 'PENDING_APPROVAL') pending_approval_kg,
            (SELECT GROUP_CONCAT(DISTINCT sy.yarn_name) FROM trx_yarn_substitution s JOIN mst_yarn sy ON sy.id = s.substitute_yarn_id WHERE s.program_yarn_id = kpy.id AND s.status = 'POSTED') substitute_yarns
       FROM trx_knitting_program_yarns kpy LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id WHERE kpy.program_id = ? ORDER BY kpy.seq_no`, [id]);
  const kp = await queryOne<any>('SELECT so_id, io_no FROM trx_knitting_program WHERE id = ? AND company_id = ?', [id, cid]);
  if (!kp) throw NotFound('Knitting program not found');
  const soId = await resolveSoId(cid, kp.so_id, kp.io_no);
  const tin = soId ? await query<any>(
    `SELECT gl.yarn_id, SUM(l.qty) kg FROM trx_job_transfer t JOIN trx_job_transfer_line l ON l.transfer_id = t.id JOIN trx_grn_line gl ON gl.id = l.grn_line_id
      WHERE t.company_id = ? AND t.material_type = 'YARN' AND t.status = 'POSTED' AND t.to_so_id = ? GROUP BY gl.yarn_id`, [cid, soId]) : [];
  res.json({ data: lines.map((l) => {
    const req_ = n(l.required_kg), iss = n(l.issued_kg), eq = n(l.substitute_eq_kg);
    return { ...l, required_kg: r3(req_), issued_kg: r3(iss), substitute_kg: r3(n(l.substitute_kg)), substitute_eq_kg: r3(eq), substitute_issued_kg: r3(n(l.substitute_issued_kg)),
      pending_approval_kg: r3(n(l.pending_approval_kg)), transfer_in_kg: r3(n(tin.find((t) => Number(t.yarn_id) === Number(l.yarn_id))?.kg)),
      pending_kg: r3(Math.max(0, req_ - iss - eq)), substitute_open_kg: r3(Math.max(0, n(l.substitute_kg) - n(l.substitute_issued_kg))) };
  }) });
}));

/** GET /jobs/:soId/yarn-ledger — requirement, outward, transfer in / out, substitution, return per yarn (doc §21). */
yarnSubstitutionRouter.get('/jobs/:soId/yarn-ledger', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>('SELECT id, COALESCE(io_no, so_no) job_no FROM trx_sales_order WHERE id = ? AND company_id = ?', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const rate = `COALESCE((SELECT sl.rate FROM trx_stock_ledger sl WHERE sl.company_id = ? AND sl.material_type = 'YARN' AND sl.yarn_id = x.yarn_id AND sl.qty_in > 0 AND sl.rate > 0 ORDER BY sl.id DESC LIMIT 1), y.std_rate, 0)`;
  const rows = await query<any>(
    `SELECT x.*, y.yarn_name, ${rate} rate FROM (
       SELECT kp.program_date dt, 'REQUIREMENT' type, kp.program_no ref, kpy.yarn_id, NULL lot_no, 0 in_kg, kpy.planned_qty_kg out_kg, kp.id sort_id
         FROM trx_knitting_program kp JOIN trx_knitting_program_yarns kpy ON kpy.program_id = kp.id WHERE kp.company_id = ? AND kp.so_id = ? AND kp.status <> 'CANCELLED'
       UNION ALL
       SELECT i.issue_date, IF(i.src_type = 'KNITTING_PROGRAM', 'KNITTING OUTWARD', 'PROCESS OUTWARD'), COALESCE(i.dc_no, i.issue_no), i.yarn_id, i.lot_no, IF(i.issued_qty_kg < 0, -i.issued_qty_kg, 0), IF(i.issued_qty_kg > 0, i.issued_qty_kg, 0), i.id
         FROM trx_process_issue i WHERE i.company_id = ? AND i.so_id = ? AND i.src_type IN ('KNITTING_PROGRAM', 'YARN_PROCESS', 'YARN_PROC_DC')
       UNION ALL
       SELECT t.transfer_date, IF(t.to_so_id = ?, 'TRANSFER IN', 'TRANSFER OUT'), t.transfer_no, gl.yarn_id, l.lot_no, IF(t.to_so_id = ?, l.qty, 0), IF(t.from_so_id = ?, l.qty, 0), t.id
         FROM trx_job_transfer t JOIN trx_job_transfer_line l ON l.transfer_id = t.id JOIN trx_grn_line gl ON gl.id = l.grn_line_id
        WHERE t.company_id = ? AND t.material_type = 'YARN' AND t.status = 'POSTED' AND (t.to_so_id = ? OR t.from_so_id = ?)
       UNION ALL
       SELECT s.request_date, 'SUBSTITUTION', s.request_no, s.substitute_yarn_id, gl.lot_no, s.qty_kg, 0, s.id
         FROM trx_yarn_substitution s LEFT JOIN trx_grn_line gl ON gl.id = s.grn_line_id WHERE s.company_id = ? AND s.so_id = ? AND s.status = 'POSTED'
       UNION ALL
       SELECT rt.return_date, 'YARN RETURN', rt.return_no, rl.yarn_id, rl.lot_no, rl.return_kg, 0, rl.id
         FROM trx_knitting_yarn_return rt JOIN trx_knitting_yarn_return_line rl ON rl.return_id = rt.id JOIN trx_knitting_program kp ON kp.id = rt.program_id
        WHERE rt.company_id = ? AND kp.so_id = ? AND rt.status <> 'CANCELLED'
     ) x LEFT JOIN mst_yarn y ON y.id = x.yarn_id ORDER BY x.dt, x.sort_id`,
    [cid, cid, soId, cid, soId, soId, soId, soId, cid, soId, soId, cid, soId, cid, soId]);
  // the job's own purchased / processed lots come in as GRN rows (opening of the running balance)
  const grns = (await yarnStockRows(cid, yarnStockQuery.parse({}))).filter((g: any) => Number(g.owner_so_id) === soId && n(g.net_in_qty) > 0);
  const rateOf = (yarnId: number) => n(rows.find((r) => Number(r.yarn_id) === Number(yarnId))?.rate);
  const all = [...rows, ...grns.map((g: any) => ({ dt: g.grn_date, type: 'GRN IN', ref: g.grn_no, yarn_id: g.yarn_id, yarn_name: g.yarn_name, lot_no: g.lot_no, in_kg: g.net_in_qty, out_kg: 0, sort_id: 0,
    rate: n(g.rate) || rateOf(g.yarn_id) }))]
    .sort((a, b) => String(a.dt).slice(0, 10).localeCompare(String(b.dt).slice(0, 10)) || (a.type === 'GRN IN' ? -1 : b.type === 'GRN IN' ? 1 : 0) || Number(a.sort_id) - Number(b.sort_id));
  res.json({ data: { job_no: so.job_no, rows: all.map((r) => ({ ...r, in_kg: r3(n(r.in_kg)), out_kg: r3(n(r.out_kg)), rate: n(r.rate), amount: Math.round((n(r.in_kg) + n(r.out_kg)) * n(r.rate) * 100) / 100 })) } });
}));
