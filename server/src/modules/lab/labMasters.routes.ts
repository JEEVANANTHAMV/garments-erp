import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { s } from '../resources/schemas.js';
import { FORMULAS, FORMULAS_FOR, INPUT_TYPES, gradeToNumber, splitList } from './labCalc.js';
import { P, TEST_SCOPES, cidOf, uidOf, idParam, labAudit, labUsers, nn, dateStr } from './labCore.js';

/**
 * Lab masters (spec §4.5, §7): test categories, units, methods, parameters, wash processes, machines and versioned
 * test plans. Masters are deactivated, never deleted. A plan version already used by a request is never changed — an
 * edit makes the next version (history keeps its interpretation, spec §4.5).
 */
export const labMastersRouter = Router();
const VIEW = requirePermission(P.VIEW);
const ADMIN = requirePermission(P.ADMIN);
const code = (max: number) => z.string().trim().min(1, 'Code is required').max(max).transform((v) => v.toUpperCase().replace(/\s+/g, '_'));

/* ---------------------------------------------------------------- simple masters (one generic CRUD) */
interface SimpleMaster { path: string; table: string; codeCol: string; schema: z.ZodObject<any>; order: string; select?: string }
const simple: SimpleMaster[] = [
  { path: 'categories', table: 'mst_lab_test_category', codeCol: 'code', order: 'sort_order, name',
    schema: z.object({ code: code(30), name: s.strReq(80), description: s.nullableStr(255), sort_order: z.coerce.number().int().default(0), is_active: z.coerce.boolean().default(true) }) },
  { path: 'units', table: 'mst_lab_unit', codeCol: 'code', order: 'code',
    schema: z.object({ code: code(20), name: s.strReq(60), symbol: s.nullableStr(20), dimension: s.nullableStr(30), is_active: z.coerce.boolean().default(true) }) },
  { path: 'methods', table: 'mst_lab_test_method', codeCol: 'method_code', order: 'method_code',
    schema: z.object({ method_code: code(40), name: s.strReq(120), standard_reference: s.nullableStr(120), revision: s.nullableStr(20), instructions: s.nullableStr(5000), is_active: z.coerce.boolean().default(true) }) },
  { path: 'wash-processes', table: 'mst_lab_wash_process', codeCol: 'code', order: 'sort_order, name',
    schema: z.object({ code: code(30), name: s.strReq(80), sort_order: z.coerce.number().int().default(0), is_active: z.coerce.boolean().default(true) }) },
  { path: 'machines', table: 'mst_lab_machine', codeCol: 'machine_code', order: 'machine_code',
    schema: z.object({ machine_code: code(30), name: s.strReq(80), machine_type: s.nullableStr(40), capacity: z.coerce.number().positive().nullish(),
      capacity_uom: s.nullableStr(10), status: z.enum(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'OUT_OF_ORDER']).default('AVAILABLE'), is_active: z.coerce.boolean().default(true) }) },
];

for (const m of simple) {
  labMastersRouter.get(`/${m.path}`, VIEW, ah(async (req, res) => {
    const active = req.query.active === '1';
    res.json({ data: await query(`SELECT * FROM ${m.table} WHERE company_id = ? ${active ? 'AND is_active = 1' : ''} ORDER BY ${m.order}`, [cidOf(req)]) });
  }));
  labMastersRouter.post(`/${m.path}`, ADMIN, ah(async (req, res) => {
    const cid = cidOf(req);
    const b = m.schema.parse(req.body ?? {}) as Record<string, unknown>;
    if (await queryOne(`SELECT id FROM ${m.table} WHERE company_id = ? AND ${m.codeCol} = ?`, [cid, b[m.codeCol]])) throw Conflict(`${b[m.codeCol]} already exists`);
    const cols = Object.keys(b);
    const r = await execute(`INSERT INTO ${m.table} (company_id, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`,
      [cid, ...cols.map((k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k] ?? null))]);
    await labAudit(req, null, { entity_type: 'MASTER', entity_id: Number(r.insertId), action: 'CREATE', after: { master: m.path, ...b } });
    res.status(201).json({ data: await queryOne(`SELECT * FROM ${m.table} WHERE id = ?`, [r.insertId]) });
  }));
  labMastersRouter.put(`/${m.path}/:id`, ADMIN, ah(async (req, res) => {
    const cid = cidOf(req); const id = idParam(req);
    const before = await queryOne<any>(`SELECT * FROM ${m.table} WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!before) throw NotFound();
    const b = m.schema.omit({ [m.codeCol]: true } as any).parse(req.body ?? {}) as Record<string, unknown>;
    const cols = Object.keys(b);
    if (cols.length) await execute(`UPDATE ${m.table} SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k] ?? null)), id]);
    await labAudit(req, null, { entity_type: 'MASTER', entity_id: id, action: 'UPDATE', before, after: { master: m.path, ...b } });
    res.json({ data: await queryOne(`SELECT * FROM ${m.table} WHERE id = ?`, [id]) });
  }));
}

/* ---------------------------------------------------------------- parameters */
const paramSchema = z.object({
  code: code(40), name: s.strReq(120), description: s.nullableStr(255), category_id: s.id(),
  input_type: z.enum(INPUT_TYPES), formula_code: z.enum(FORMULAS).nullish(),
  unit_id: s.id(), reading_unit_id: s.id(), precision_dp: z.coerce.number().int().min(0).max(6).default(2),
  allowed_values: s.nullableStr(500), default_method_id: s.id(), is_active: z.coerce.boolean().default(true),
});

async function checkParam(cid: number, b: z.infer<typeof paramSchema>) {
  const formula = b.formula_code ?? FORMULAS_FOR[b.input_type][0];
  if (!FORMULAS_FOR[b.input_type].includes(formula)) throw BadRequest(`${b.input_type} parameters use ${FORMULAS_FOR[b.input_type].join(' / ')}`);
  if ((b.input_type === 'DROPDOWN' || b.input_type === 'GRADE') && splitList(b.allowed_values).length < 2) throw BadRequest('List at least two choices / grades (comma separated)');
  if (b.input_type === 'GRADE' && splitList(b.allowed_values).some((g) => gradeToNumber(g) == null)) throw BadRequest('Grades must be numbers like 1, 2, 3-4, 4-5');
  for (const [k, t] of [['category_id', 'mst_lab_test_category'], ['unit_id', 'mst_lab_unit'], ['reading_unit_id', 'mst_lab_unit'], ['default_method_id', 'mst_lab_test_method']] as const) {
    const v = b[k];
    if (v && !(await queryOne(`SELECT id FROM ${t} WHERE id = ? AND company_id = ?`, [v, cid]))) throw BadRequest(`${k.replace(/_id$/, '').replace(/_/g, ' ')} not found`);
  }
  return { ...b, formula_code: formula, data_type: ['TEXT', 'DROPDOWN', 'PASS_FAIL', 'PHOTO'].includes(b.input_type) ? 'TEXT' : 'DECIMAL' };
}

labMastersRouter.get('/parameters', VIEW, ah(async (req, res) => {
  res.json({ data: await query(
    `SELECT p.*, c.name AS category_name, c.code AS category_code, u.symbol AS unit_symbol, ru.symbol AS reading_unit_symbol, m.method_code AS default_method_code
       FROM mst_lab_test_parameter p LEFT JOIN mst_lab_test_category c ON c.id = p.category_id LEFT JOIN mst_lab_unit u ON u.id = p.unit_id
       LEFT JOIN mst_lab_unit ru ON ru.id = p.reading_unit_id LEFT JOIN mst_lab_test_method m ON m.id = p.default_method_id
      WHERE p.company_id = ? ${req.query.active === '1' ? 'AND p.is_active = 1' : ''} ORDER BY c.sort_order, p.name`, [cidOf(req)]) });
}));
labMastersRouter.post('/parameters', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = await checkParam(cid, paramSchema.parse(req.body ?? {}));
  if (await queryOne(`SELECT id FROM mst_lab_test_parameter WHERE company_id = ? AND code = ?`, [cid, b.code])) throw Conflict(`Parameter ${b.code} already exists`);
  const r = await execute(
    `INSERT INTO mst_lab_test_parameter (company_id, category_id, code, name, description, input_type, data_type, formula_code, unit_id, reading_unit_id, precision_dp, allowed_values, default_method_id, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, b.category_id ?? null, b.code, b.name, b.description ?? null, b.input_type, b.data_type, b.formula_code, b.unit_id ?? null, b.reading_unit_id ?? null,
      b.precision_dp, b.allowed_values ?? null, b.default_method_id ?? null, b.is_active ? 1 : 0]);
  await labAudit(req, null, { entity_type: 'MASTER', entity_id: Number(r.insertId), action: 'CREATE', after: { master: 'parameters', ...b } });
  res.status(201).json({ data: await queryOne(`SELECT * FROM mst_lab_test_parameter WHERE id = ?`, [r.insertId]) });
}));
labMastersRouter.put('/parameters/:id', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const before = await queryOne<any>(`SELECT * FROM mst_lab_test_parameter WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Parameter not found');
  const b = await checkParam(cid, paramSchema.parse({ ...(req.body ?? {}), code: before.code }));
  // plans and trials keep their own snapshot, so a master edit never changes a historical result
  await execute(
    `UPDATE mst_lab_test_parameter SET category_id = ?, name = ?, description = ?, input_type = ?, data_type = ?, formula_code = ?, unit_id = ?, reading_unit_id = ?,
            precision_dp = ?, allowed_values = ?, default_method_id = ?, is_active = ? WHERE id = ?`,
    [b.category_id ?? null, b.name, b.description ?? null, b.input_type, b.data_type, b.formula_code, b.unit_id ?? null, b.reading_unit_id ?? null,
      b.precision_dp, b.allowed_values ?? null, b.default_method_id ?? null, b.is_active ? 1 : 0, id]);
  await labAudit(req, null, { entity_type: 'MASTER', entity_id: id, action: 'UPDATE', before, after: { master: 'parameters', ...b } });
  res.json({ data: await queryOne(`SELECT * FROM mst_lab_test_parameter WHERE id = ?`, [id]) });
}));

/* ---------------------------------------------------------------- test plans (versioned) */
const planParamSchema = z.object({
  parameter_id: s.idReq(), method_id: s.id(), seq_no: z.coerce.number().int().min(0).default(0), is_mandatory: z.coerce.boolean().default(true),
  repeat_count: z.coerce.number().int().min(1).max(20).default(1),
  min_value: z.coerce.number().nullish(), max_value: z.coerce.number().nullish(), target_value: z.coerce.number().nullish(),
  tolerance: z.coerce.number().min(0, 'Tolerance cannot be negative').nullish(), borderline_band: z.coerce.number().min(0).nullish(),
  pass_values: s.nullableStr(500), evidence_required: z.coerce.boolean().default(false), remarks: s.nullableStr(255),
});
const planSchema = z.object({
  plan_code: code(40), name: s.strReq(120), buyer_id: s.id(), product_id: s.id(), fabric_type: s.nullableStr(40), composition_id: s.id(), style_id: s.id(),
  test_scope: z.array(z.enum(TEST_SCOPES)).nullish(), effective_from: dateStr.nullish(), effective_to: dateStr.nullish(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).default('DRAFT'), remarks: s.nullableStr(255),
  params: z.array(planParamSchema).min(1, 'Add at least one parameter').max(100),
});

async function checkPlan(cid: number, b: z.infer<typeof planSchema>) {
  if (b.effective_from && b.effective_to && b.effective_to < b.effective_from) throw BadRequest('Effective to is before effective from');
  const ids = b.params.map((p) => p.parameter_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('A parameter is listed twice');
  const params = await query<any>(`SELECT * FROM mst_lab_test_parameter WHERE company_id = ? AND id IN (?)`, [cid, ids]);
  for (const pp of b.params) {
    const p = params.find((x) => Number(x.id) === pp.parameter_id);
    if (!p) throw BadRequest(`Parameter ${pp.parameter_id} not found`);
    if (!Number(p.is_active)) throw BadRequest(`Parameter ${p.code} is inactive`);
    if (pp.min_value != null && pp.max_value != null && pp.min_value > pp.max_value) throw BadRequest(`${p.name}: minimum is above maximum`);
    if ((pp.target_value == null) !== (pp.tolerance == null) && pp.min_value == null && pp.max_value == null) throw BadRequest(`${p.name}: give target and tolerance together`);
    if (p.input_type === 'GRADE') {
      const scale = splitList(p.allowed_values).map(gradeToNumber).filter((x): x is number => x != null);
      for (const v of [pp.min_value, pp.max_value]) if (v != null && (v < Math.min(...scale) || v > Math.max(...scale))) throw BadRequest(`${p.name}: grade limit ${v} is off the scale`);
    }
    if (p.input_type === 'DROPDOWN' && pp.pass_values) {
      const allowed = splitList(p.allowed_values);
      const bad = splitList(pp.pass_values).filter((v) => !allowed.includes(v));
      if (bad.length) throw BadRequest(`${p.name}: pass value(s) ${bad.join(', ')} are not among the choices`);
    }
    if (pp.method_id && !(await queryOne(`SELECT id FROM mst_lab_test_method WHERE id = ? AND company_id = ?`, [pp.method_id, cid]))) throw BadRequest(`${p.name}: method not found`);
  }
  if (b.buyer_id && !(await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [b.buyer_id, cid]))) throw BadRequest('Buyer not found');
  if (b.style_id && !(await queryOne(`SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [b.style_id, cid]))) throw BadRequest('Style not found');
  if (b.product_id && !(await queryOne(`SELECT id FROM mst_product WHERE id = ? AND company_id = ?`, [b.product_id, cid]))) throw BadRequest('Product not found');
}

async function planDetail(cid: number, id: number) {
  const plan = await queryOne<any>(
    `SELECT pl.*, b.party_name AS buyer_name, st.style_code, pr.product_name, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM trx_lab_request r WHERE r.test_plan_id = pl.id) AS request_count
       FROM mst_lab_test_plan pl LEFT JOIN mst_party b ON b.id = pl.buyer_id LEFT JOIN mst_style st ON st.id = pl.style_id
       LEFT JOIN mst_product pr ON pr.id = pl.product_id LEFT JOIN mst_user u ON u.id = pl.created_by
      WHERE pl.id = ? AND pl.company_id = ?`, [id, cid]);
  if (!plan) throw NotFound('Test plan not found');
  const params = await query<any>(
    `SELECT pp.*, p.code, p.name, p.input_type, p.formula_code, p.precision_dp, p.allowed_values, u.symbol AS unit_symbol, ru.symbol AS reading_unit_symbol,
            m.method_code, m.name AS method_name, c.name AS category_name
       FROM mst_lab_test_plan_param pp JOIN mst_lab_test_parameter p ON p.id = pp.parameter_id
       LEFT JOIN mst_lab_unit u ON u.id = p.unit_id LEFT JOIN mst_lab_unit ru ON ru.id = p.reading_unit_id
       LEFT JOIN mst_lab_test_method m ON m.id = pp.method_id LEFT JOIN mst_lab_test_category c ON c.id = p.category_id
      WHERE pp.plan_id = ? ORDER BY pp.seq_no, pp.id`, [id]);
  const versions = await query<any>(`SELECT id, version_no, status, effective_from, effective_to, created_at FROM mst_lab_test_plan WHERE company_id = ? AND plan_code = ? ORDER BY version_no DESC`, [cid, plan.plan_code]);
  return { ...plan, test_scope: splitList(plan.test_scope), params, versions };
}

labMastersRouter.get('/test-plans', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const all = req.query.all === '1';
  const rows = await query<any>(
    `SELECT pl.*, b.party_name AS buyer_name, st.style_code, pr.product_name,
            (SELECT COUNT(*) FROM mst_lab_test_plan_param pp WHERE pp.plan_id = pl.id) AS param_count,
            (SELECT COUNT(*) FROM trx_lab_request r WHERE r.test_plan_id = pl.id) AS request_count
       FROM mst_lab_test_plan pl LEFT JOIN mst_party b ON b.id = pl.buyer_id LEFT JOIN mst_style st ON st.id = pl.style_id
       LEFT JOIN mst_product pr ON pr.id = pl.product_id
      WHERE pl.company_id = ? ${all ? '' : 'AND pl.version_no = (SELECT MAX(x.version_no) FROM mst_lab_test_plan x WHERE x.company_id = pl.company_id AND x.plan_code = pl.plan_code)'}
      ORDER BY pl.plan_code, pl.version_no DESC`, [cid]);
  res.json({ data: rows.map((r) => ({ ...r, test_scope: splitList(r.test_scope) })) });
}));

/** Active, in-date plans that apply to the request context (a plan field left blank applies to any value). */
labMastersRouter.get('/test-plans/applicable', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ buyer_id: s.id(), style_id: s.id(), fabric_id: s.id(), scope: z.string().nullish(), on: dateStr.nullish() }).parse(req.query);
  let fabricType: string | null = null; let compositionId: number | null = null; let productId: number | null = null;
  if (q.fabric_id) {
    const f = await queryOne<any>(`SELECT fabric_type, composition_id FROM mst_fabric WHERE id = ? AND company_id = ?`, [q.fabric_id, cid]);
    fabricType = f?.fabric_type ?? null; compositionId = nn(f?.composition_id);
  }
  if (q.style_id) productId = nn((await queryOne<any>(`SELECT product_id FROM mst_style WHERE id = ? AND company_id = ?`, [q.style_id, cid]))?.product_id);
  const rows = await query<any>(
    `SELECT pl.id, pl.plan_code, pl.version_no, pl.name, pl.buyer_id, pl.style_id, pl.test_scope, b.party_name AS buyer_name, st.style_code
       FROM mst_lab_test_plan pl LEFT JOIN mst_party b ON b.id = pl.buyer_id LEFT JOIN mst_style st ON st.id = pl.style_id
      WHERE pl.company_id = ? AND pl.status = 'ACTIVE'
        AND (pl.effective_from IS NULL OR pl.effective_from <= COALESCE(?, CURDATE())) AND (pl.effective_to IS NULL OR pl.effective_to >= COALESCE(?, CURDATE()))
        AND (pl.buyer_id IS NULL OR pl.buyer_id <=> ?) AND (pl.style_id IS NULL OR pl.style_id <=> ?)
        AND (pl.product_id IS NULL OR pl.product_id <=> ?) AND (pl.fabric_type IS NULL OR pl.fabric_type <=> ?) AND (pl.composition_id IS NULL OR pl.composition_id <=> ?)
      ORDER BY (pl.style_id IS NOT NULL) DESC, (pl.buyer_id IS NOT NULL) DESC, pl.plan_code`,
    [cid, q.on ?? null, q.on ?? null, q.buyer_id ?? null, q.style_id ?? null, productId, fabricType, compositionId]);
  const scopes = splitList(q.scope);
  res.json({ data: rows.filter((r) => !r.test_scope || !scopes.length || splitList(r.test_scope).some((x) => scopes.includes(x) || x === 'COMBINED'))
    .map((r) => ({ ...r, label: `${r.plan_code} v${r.version_no} — ${r.name}` })) });
}));

labMastersRouter.get('/test-plans/:id', VIEW, ah(async (req, res) => { res.json({ data: await planDetail(cidOf(req), idParam(req)) }); }));

async function writePlanParams(tx: any, planId: number, params: z.infer<typeof planParamSchema>[]) {
  let i = 0;
  for (const p of params) {
    await txExecute(tx,
      `INSERT INTO mst_lab_test_plan_param (plan_id, parameter_id, method_id, seq_no, is_mandatory, repeat_count, min_value, max_value, target_value, tolerance,
              borderline_band, pass_values, evidence_required, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [planId, p.parameter_id, p.method_id ?? null, p.seq_no || ++i * 10, p.is_mandatory ? 1 : 0, p.repeat_count, p.min_value ?? null, p.max_value ?? null,
        p.target_value ?? null, p.tolerance ?? null, p.borderline_band ?? null, p.pass_values ?? null, p.evidence_required ? 1 : 0, p.remarks ?? null]);
  }
}

labMastersRouter.post('/test-plans', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = planSchema.parse(req.body ?? {});
  await checkPlan(cid, b);
  if (await queryOne(`SELECT id FROM mst_lab_test_plan WHERE company_id = ? AND plan_code = ?`, [cid, b.plan_code])) throw Conflict(`Plan ${b.plan_code} already exists — edit it to make a new version`);
  const id = await transaction(async (tx) => {
    const r = await txExecute(tx,
      `INSERT INTO mst_lab_test_plan (company_id, plan_code, version_no, name, buyer_id, product_id, fabric_type, composition_id, style_id, test_scope,
              effective_from, effective_to, status, remarks, created_by) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, b.plan_code, b.name, b.buyer_id ?? null, b.product_id ?? null, b.fabric_type ?? null, b.composition_id ?? null, b.style_id ?? null,
        b.test_scope?.length ? b.test_scope.join(',') : null, b.effective_from ?? null, b.effective_to ?? null, b.status, b.remarks ?? null, uidOf(req)]);
    await writePlanParams(tx, Number(r.insertId), b.params);
    await labAudit(req, tx, { entity_type: 'PLAN', entity_id: Number(r.insertId), action: 'CREATE', after: { plan_code: b.plan_code, version_no: 1, status: b.status, params: b.params.length } });
    return Number(r.insertId);
  });
  res.status(201).json({ data: await planDetail(cid, id) });
}));

/** Edit a plan: an unused version is changed in place; a version used by a request makes version + 1. */
labMastersRouter.put('/test-plans/:id', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const cur = await queryOne<any>(`SELECT * FROM mst_lab_test_plan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!cur) throw NotFound('Test plan not found');
  const b = planSchema.parse({ ...(req.body ?? {}), plan_code: cur.plan_code });
  await checkPlan(cid, b);
  const out = await transaction(async (tx) => {
    const latest = await txQueryOne<any>(tx, `SELECT MAX(version_no) v FROM mst_lab_test_plan WHERE company_id = ? AND plan_code = ? FOR UPDATE`, [cid, cur.plan_code]);
    if (Number(latest?.v) !== Number(cur.version_no)) throw Conflict(`Version ${latest?.v} is newer — edit the latest version`);
    const used = Number((await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_lab_request WHERE test_plan_id = ?`, [id]))?.c) > 0;
    const vals = [b.name, b.buyer_id ?? null, b.product_id ?? null, b.fabric_type ?? null, b.composition_id ?? null, b.style_id ?? null,
      b.test_scope?.length ? b.test_scope.join(',') : null, b.effective_from ?? null, b.effective_to ?? null, b.status, b.remarks ?? null];
    let planId = id; let version = Number(cur.version_no);
    if (!used) {
      await txExecute(tx, `UPDATE mst_lab_test_plan SET name = ?, buyer_id = ?, product_id = ?, fabric_type = ?, composition_id = ?, style_id = ?, test_scope = ?,
              effective_from = ?, effective_to = ?, status = ?, remarks = ? WHERE id = ?`, [...vals, id]);
      await txExecute(tx, `DELETE FROM mst_lab_test_plan_param WHERE plan_id = ?`, [id]);
    } else {
      version += 1;
      const r = await txExecute(tx,
        `INSERT INTO mst_lab_test_plan (company_id, plan_code, version_no, name, buyer_id, product_id, fabric_type, composition_id, style_id, test_scope,
                effective_from, effective_to, status, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, cur.plan_code, version, ...vals, uidOf(req)]);
      planId = Number(r.insertId);
      if (b.status === 'ACTIVE') await txExecute(tx, `UPDATE mst_lab_test_plan SET status = 'SUPERSEDED' WHERE company_id = ? AND plan_code = ? AND id <> ? AND status = 'ACTIVE'`, [cid, cur.plan_code, planId]);
    }
    await writePlanParams(tx, planId, b.params);
    await labAudit(req, tx, { entity_type: 'PLAN', entity_id: planId, action: used ? 'NEW_VERSION' : 'UPDATE', before: { version_no: cur.version_no, status: cur.status },
      after: { plan_code: cur.plan_code, version_no: version, status: b.status, params: b.params.length } });
    return { id: planId, new_version: used };
  });
  res.json({ data: { ...(await planDetail(cid, out.id)), new_version: out.new_version } });
}));

labMastersRouter.post('/test-plans/:id/status', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }).parse(req.body ?? {});
  const cur = await queryOne<any>(`SELECT * FROM mst_lab_test_plan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!cur) throw NotFound('Test plan not found');
  await transaction(async (tx) => {
    if (b.status === 'ACTIVE') {
      const n = Number((await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM mst_lab_test_plan_param WHERE plan_id = ?`, [id]))?.c);
      if (!n) throw BadRequest('The plan has no parameters');
      await txExecute(tx, `UPDATE mst_lab_test_plan SET status = 'SUPERSEDED' WHERE company_id = ? AND plan_code = ? AND id <> ? AND status = 'ACTIVE'`, [cid, cur.plan_code, id]);
    }
    await txExecute(tx, `UPDATE mst_lab_test_plan SET status = ? WHERE id = ?`, [b.status, id]);
    await labAudit(req, tx, { entity_type: 'PLAN', entity_id: id, action: b.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE', before: { status: cur.status }, after: { status: b.status } });
  });
  res.json({ data: await planDetail(cid, id) });
}));

/* ---------------------------------------------------------------- lab users (technician / approver pickers) */
labMastersRouter.get('/users', VIEW, ah(async (req, res) => {
  const perm = z.enum([P.UPDATE, P.APPROVE, P.QA]).default(P.UPDATE).parse(req.query.perm ?? undefined);
  res.json({ data: await labUsers(cidOf(req), perm) });
}));

/** Everything a lab form needs in one call. */
labMastersRouter.get('/form-options', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const [categories, units, methods, washProcesses, machines, parameters, technicians] = await Promise.all([
    query(`SELECT id, code, name FROM mst_lab_test_category WHERE company_id = ? AND is_active = 1 ORDER BY sort_order, name`, [cid]),
    query(`SELECT id, code, name, symbol FROM mst_lab_unit WHERE company_id = ? AND is_active = 1 ORDER BY code`, [cid]),
    query(`SELECT id, method_code, name, standard_reference, revision FROM mst_lab_test_method WHERE company_id = ? AND is_active = 1 ORDER BY method_code`, [cid]),
    query(`SELECT id, code, name FROM mst_lab_wash_process WHERE company_id = ? AND is_active = 1 ORDER BY sort_order, name`, [cid]),
    query(`SELECT id, machine_code, name, machine_type, capacity, capacity_uom, status FROM mst_lab_machine WHERE company_id = ? AND is_active = 1 ORDER BY machine_code`, [cid]),
    query(`SELECT id, code, name, input_type, formula_code FROM mst_lab_test_parameter WHERE company_id = ? AND is_active = 1 ORDER BY name`, [cid]),
    labUsers(cid, P.UPDATE),
  ]);
  const chemicals = await txFreeChemicals(cid);
  res.json({ data: { categories, units, methods, wash_processes: washProcesses, machines, parameters, technicians, chemicals } });
}));

/** Chemical references: ERP trims of chemical / dye types first (no stock movement from the lab). */
async function txFreeChemicals(cid: number) {
  return query(
    `SELECT t.id, t.trim_code AS code, t.trim_name AS label, t.trim_type FROM mst_trim t
      WHERE t.company_id = ? AND t.is_active = 1 AND t.is_deleted = 0 AND t.trim_type IN ('CHEMICAL','DYE','PIGMENT','BINDER','SOFTENER','ENZYME','INK')
      ORDER BY t.trim_name LIMIT 500`, [cid]);
}

