import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { calcRollFor, fabricSpec, normForm, parseDia, resolveRule, rollTolerances, solve, widthM } from '../../core/fabricRollCalc.js';

/**
 * Fabric roll GSM / Dia / meter (client doc 03-Oct-2026):
 *   POST /fabric-rolls/calculate     preview of one roll (server formula; screens only preview)
 *   POST /fabric-calc/solve          KG ↔ meter ↔ GSM ↔ width calculator
 *   GET  /fabrics/:id/specification  target GSM, min / max, form, Dia, width M and the rule
 *   /dia-width-rules                 Dia → width conversion master (draft → approved, effective dated)
 *   GET  /fabric-rolls/gsm-variance  target vs actual GSM, calculated vs actual meter + suggested rule factor
 */
export const fabricRollCalcRouter = Router();
const VIEW = ['MATERIAL.VIEW', 'INVENTORY.VIEW', 'PRODUCTION.VIEW', 'GRN.VIEW', 'FABRIC_PROCESS.VIEW'];
const n = (v: unknown) => Number(v ?? 0) || 0;

const calcSchema = z.object({
  fabric_id: z.coerce.number().int().positive().nullish(),
  weight_kg: z.coerce.number().positive('Roll KG must be more than 0'),
  target_gsm: z.coerce.number().positive().nullish(),
  actual_gsm: z.coerce.number().positive().nullish(),
  dia: z.union([z.string(), z.number()]).nullish(),
  fabric_form: z.string().nullish(),
  actual_meters: z.coerce.number().positive().nullish(),
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});
fabricRollCalcRouter.post('/fabric-rolls/calculate', requireAny(...VIEW), ah(async (req, res) => {
  const b = calcSchema.parse(req.body);
  const c = await calcRollFor(req.user!.companyId, { ...b, dia: b.dia == null ? null : String(b.dia) });
  if (!c.width_m) throw BadRequest('Enter the Dia (or width) — the meter needs the fabric width');
  if (!c.calc_meters) throw BadRequest('Enter the GSM (target or actual)');
  res.json({ data: c });
}));

fabricRollCalcRouter.post('/fabric-calc/solve', requireAny(...VIEW), ah(async (req, res) => {
  const b = z.object({ weight_kg: z.coerce.number().min(0).nullish(), meters: z.coerce.number().min(0).nullish(), gsm: z.coerce.number().min(0).nullish(),
    width_m: z.coerce.number().min(0).nullish(), dia: z.union([z.string(), z.number()]).nullish(), fabric_form: z.string().nullish() }).parse(req.body);
  let width = n(b.width_m) || null; let rule = null;
  if (!width && b.dia != null && String(b.dia).trim()) {
    const d = parseDia(b.dia);
    const form = normForm(b.fabric_form) ?? d.form ?? 'TUBULAR';
    rule = await resolveRule(req.user!.companyId, form);
    width = d.inch ? Math.round(widthM(d.inch, rule) * 100000) / 100000 : null;
  }
  const r = solve({ weight_kg: b.weight_kg, meters: b.meters, gsm: b.gsm, width_m: width });
  if (!r.solved) throw BadRequest('Fill exactly three of KG, meter, GSM and width / Dia — the fourth is calculated');
  res.json({ data: { ...r, width_m: (r as any).width_m ?? width, rule_code: rule?.rule_code ?? null } });
}));

fabricRollCalcRouter.get('/fabrics/:id/specification', requireAny(...VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const f = await queryOne<any>('SELECT id, fabric_code, fabric_name FROM mst_fabric WHERE id = ? AND company_id = ?', [id, cid]);
  if (!f) throw NotFound('Fabric not found');
  const spec = await fabricSpec(id);
  const form = spec?.fabric_form ?? 'TUBULAR';
  const rule = await resolveRule(cid, form);
  res.json({ data: { ...f, ...spec, fabric_form: form, rule_code: rule.rule_code, rule_factor: rule.formula_type === 'DIRECT' ? 1 : rule.formula_type === 'CIRCUMFERENCE' ? Math.PI : rule.factor,
    width_m: spec?.dia_inch ? Math.round(widthM(spec.dia_inch, rule) * 100000) / 100000 : null, tolerances: await rollTolerances(cid) } });
}));

// ---------------------------------------------------------------- Dia / width rules
const ruleSchema = z.object({
  rule_code: z.string().trim().min(2).max(30),
  fabric_form: z.enum(['TUBULAR', 'OPEN_WIDTH']),
  dia_definition: z.string().trim().min(2).max(60),
  formula_type: z.enum(['DIRECT', 'FACTOR', 'CIRCUMFERENCE']),
  factor: z.coerce.number().positive().max(10).default(1),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  is_active: z.coerce.boolean().default(true),
  remarks: z.string().trim().max(255).nullish(),
});
fabricRollCalcRouter.get('/dia-width-rules', requireAny(...VIEW), ah(async (req, res) => {
  const rows = await query<any>(`SELECT r.*, u.full_name AS approved_by_name FROM mst_dia_width_rule r LEFT JOIN mst_user u ON u.id = r.approved_by
                                  WHERE r.company_id = ? ORDER BY r.fabric_form, r.effective_from DESC, r.id DESC`, [req.user!.companyId]);
  const inUse = { TUBULAR: await resolveRule(req.user!.companyId, 'TUBULAR'), OPEN_WIDTH: await resolveRule(req.user!.companyId, 'OPEN_WIDTH') };
  res.json({ data: rows.map((r) => ({ ...r, factor: n(r.factor), in_use: inUse[r.fabric_form as 'TUBULAR' | 'OPEN_WIDTH']?.id === Number(r.id) })) });
}));
/** New rule = DRAFT; it is used only after approval. */
fabricRollCalcRouter.post('/dia-width-rules', requirePermission('MATERIAL.CREATE'), ah(async (req, res) => {
  const b = ruleSchema.parse(req.body);
  const dup = await queryOne<any>('SELECT id FROM mst_dia_width_rule WHERE company_id = ? AND rule_code = ?', [req.user!.companyId, b.rule_code]);
  if (dup) throw BadRequest(`Rule ${b.rule_code} already exists`);
  const r = await execute(`INSERT INTO mst_dia_width_rule (company_id, rule_code, fabric_form, dia_definition, formula_type, factor, effective_from, effective_to, approval_status, is_active, remarks, created_by)
    VALUES (?,?,?,?,?,?,?,?, 'DRAFT', ?,?,?)`, [req.user!.companyId, b.rule_code, b.fabric_form, b.dia_definition, b.formula_type, b.formula_type === 'FACTOR' ? b.factor : 1,
    b.effective_from, b.effective_to ?? null, b.is_active ? 1 : 0, b.remarks ?? null, req.user!.id]);
  await audit(req, 'mst_dia_width_rule', Number(r.insertId), 'INSERT', undefined, b);
  res.status(201).json({ data: { id: Number(r.insertId) }, message: `Rule ${b.rule_code} saved as draft — approve it to use it` });
}));
/** A draft can be changed freely; an approved rule only gets its end date / active flag (make a new rule for a new factor). */
fabricRollCalcRouter.put('/dia-width-rules/:id', requirePermission('MATERIAL.UPDATE'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const old = await queryOne<any>('SELECT * FROM mst_dia_width_rule WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!old) throw NotFound('Rule not found');
  const b = ruleSchema.parse(req.body);
  if (old.approval_status === 'APPROVED') {
    if (b.formula_type !== old.formula_type || Math.abs(b.factor - n(old.factor)) > 1e-9 || b.fabric_form !== old.fabric_form || b.effective_from !== String(old.effective_from).slice(0, 10)) {
      throw BadRequest('An approved rule cannot change its formula, factor, form or start date — add a new rule with a later effective date');
    }
    await query('UPDATE mst_dia_width_rule SET effective_to = ?, is_active = ?, remarks = ?, dia_definition = ? WHERE id = ?', [b.effective_to ?? null, b.is_active ? 1 : 0, b.remarks ?? null, b.dia_definition, id]);
  } else {
    await query(`UPDATE mst_dia_width_rule SET rule_code = ?, fabric_form = ?, dia_definition = ?, formula_type = ?, factor = ?, effective_from = ?, effective_to = ?, is_active = ?, remarks = ? WHERE id = ?`,
      [b.rule_code, b.fabric_form, b.dia_definition, b.formula_type, b.formula_type === 'FACTOR' ? b.factor : 1, b.effective_from, b.effective_to ?? null, b.is_active ? 1 : 0, b.remarks ?? null, id]);
  }
  await audit(req, 'mst_dia_width_rule', id, 'UPDATE', old, b);
  res.json({ data: { id }, message: 'Rule saved' });
}));
fabricRollCalcRouter.post('/dia-width-rules/:id/approve', requirePermission('MATERIAL.UPDATE'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const old = await queryOne<any>('SELECT * FROM mst_dia_width_rule WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!old) throw NotFound('Rule not found');
  if (old.approval_status === 'APPROVED') throw BadRequest(`${old.rule_code} is already approved`);
  await query(`UPDATE mst_dia_width_rule SET approval_status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
  await audit(req, 'mst_dia_width_rule', id, 'UPDATE', { approval_status: old.approval_status }, { approval_status: 'APPROVED' });
  res.json({ data: { id }, message: `${old.rule_code} approved — used from ${String(old.effective_from).slice(0, 10)}` });
}));

// ---------------------------------------------------------------- variance report
/**
 * Rolls with their calculation: target vs actual GSM, calculated vs actual meter. The summary per fabric / form / Dia
 * gives the average variance and the factor the measured rolls imply (actual width ÷ Dia) — the figure to tune the
 * Dia/Width rule with, so the ERP's auto meter comes close to what is actually received.
 */
fabricRollCalcRouter.get('/fabric-rolls/gsm-variance', requireAny(...VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ from: z.string().optional(), to: z.string().optional(), fabric_id: z.coerce.number().int().optional(), so_id: z.coerce.number().int().optional(),
    flagged: z.coerce.number().int().optional(), measured: z.coerce.number().int().optional() }).parse(req.query);
  const w = ['fr.company_id = ?', 'fr.calc_meters IS NOT NULL']; const p: unknown[] = [cid];
  if (q.from) { w.push('g.grn_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('g.grn_date <= ?'); p.push(q.to); }
  if (q.fabric_id) { w.push('fr.fabric_id = ?'); p.push(q.fabric_id); }
  if (q.so_id) { w.push('fr.so_id = ?'); p.push(q.so_id); }
  if (q.flagged) w.push(`fr.gsm_flag = 'OUT_OF_TOLERANCE'`);
  if (q.measured) w.push('(fr.actual_meters IS NOT NULL OR fr.actual_gsm IS NOT NULL)');
  const rows = await query<any>(
    `SELECT fr.id, fr.roll_no, fr.weight_kg, fr.dia, fr.fabric_form, fr.width_m, fr.target_gsm, fr.actual_gsm, fr.calc_meters, fr.actual_meters, fr.meters,
            fr.meter_var_pct, fr.gsm_var_pct, fr.calc_basis, fr.gsm_flag, fr.qc_status, fr.process_state, fr.color_name, fr.fabric_id,
            fb.fabric_name, g.grn_no, g.grn_date, COALESCE(so.io_no, so.so_no) AS io_no, r.rule_code, r.factor AS rule_factor, r.formula_type
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN trx_sales_order so ON so.id = fr.so_id
       LEFT JOIN mst_dia_width_rule r ON r.id = fr.dia_rule_id
      WHERE ${w.join(' AND ')} ORDER BY g.grn_date DESC, fr.id DESC LIMIT 3000`, p);
  const groups = new Map<string, any>();
  for (const r of rows) {
    const dia = parseDia(r.dia).inch;
    const k = `${r.fabric_id}|${r.fabric_form ?? ''}|${dia ?? ''}`;
    const gq = groups.get(k) ?? { fabric_id: r.fabric_id, fabric_name: r.fabric_name, fabric_form: r.fabric_form, dia_inch: dia, rolls: 0, measured: 0, kg: 0, calc_m: 0, actual_m: 0,
      gsm_var_sum: 0, gsm_n: 0, factor_sum: 0, factor_n: 0, flagged: 0, rule_factor: r.formula_type === 'FACTOR' ? n(r.rule_factor) : r.formula_type === 'CIRCUMFERENCE' ? Math.PI : 1 };
    gq.rolls += 1; gq.kg += n(r.weight_kg); gq.flagged += r.gsm_flag ? 1 : 0;
    if (r.actual_meters) {
      gq.measured += 1; gq.calc_m += n(r.calc_meters); gq.actual_m += n(r.actual_meters);
      // the width the roll actually has at its target GSM → the factor it implies for this Dia
      if (dia && r.target_gsm) { const wAct = (n(r.weight_kg) * 1000) / (n(r.target_gsm) * n(r.actual_meters)); gq.factor_sum += wAct / (dia * 0.0254); gq.factor_n += 1; }
    }
    if (r.gsm_var_pct != null) { gq.gsm_var_sum += n(r.gsm_var_pct); gq.gsm_n += 1; }
    groups.set(k, gq);
  }
  const summary = [...groups.values()].map((gq) => ({
    fabric_id: gq.fabric_id, fabric_name: gq.fabric_name, fabric_form: gq.fabric_form, dia_inch: gq.dia_inch, rolls: gq.rolls, measured_rolls: gq.measured, flagged: gq.flagged,
    kg: Math.round(gq.kg * 1000) / 1000,
    meter_var_pct: gq.calc_m > 0 ? Math.round(((gq.actual_m - gq.calc_m) / gq.calc_m) * 100000) / 1000 : null,
    avg_gsm_var_pct: gq.gsm_n ? Math.round((gq.gsm_var_sum / gq.gsm_n) * 1000) / 1000 : null,
    rule_factor: Math.round(gq.rule_factor * 10000) / 10000,
    suggested_factor: gq.factor_n ? Math.round((gq.factor_sum / gq.factor_n) * 10000) / 10000 : null,
  }));
  res.json({ data: rows, summary });
}));
