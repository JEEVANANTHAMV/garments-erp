import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQueryOne, txQuery, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { calculateStandardConsumption, r6, type Kind } from './mpCalc.js';
import { n, LABEL, DOC, MACHINE_TYPES, ROLES, machineOf, stockFactor } from './mpShared.js';

/**
 * Masters of the embroidery / printing engine: machines with effective-dated rates, downtime / reject
 * reasons, designs (artwork) and recipes. Designs and recipes are version controlled — an approved version
 * is never edited (a new version is made), so a job keeps the exact standard it was planned with.
 */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = () => z.coerce.number().min(0).max(1e9).default(0);

const rateSchema = z.object({
  effective_from: dateStr,
  costing_method: z.enum(['MACHINE_HOUR', 'COMPONENT']).default('COMPONENT'),
  rate_basis: z.enum(['MACHINE', 'HEAD']).default('MACHINE'),
  machine_hour_rate: money(), depreciation_rate_hour: money(), electricity_rate_hour: money(), maintenance_rate_hour: money(),
  overhead_basis: z.enum(['HOUR', 'PERCENT']).default('HOUR'),
  overhead_rate_hour: money(), overhead_pct: z.coerce.number().min(0).max(500).default(0),
  operator_rate_hour: money(), helper_rate_hour: money(),
  remarks: s.nullableStr(255),
}).superRefine((r, ctx) => {
  if (r.costing_method === 'MACHINE_HOUR' && !(r.machine_hour_rate > 0)) ctx.addIssue({ code: 'custom', path: ['machine_hour_rate'], message: 'Machine hour rate is required for the machine-hour method' });
  if (r.costing_method === 'COMPONENT' && !(r.depreciation_rate_hour + r.electricity_rate_hour + r.maintenance_rate_hour > 0)) {
    ctx.addIssue({ code: 'custom', path: ['depreciation_rate_hour'], message: 'Give at least one of depreciation / electricity / maintenance per hour' });
  }
});

export function mountMasters(router: Router, kind: Kind) {
  const P = (v: string) => `${kind}.${v}`;
  const L = LABEL[kind];

  // ================================================================= machines
  const machineSchema = z.object({
    machine_code: s.strReq(40),
    machine_name: s.strReq(120),
    machine_type: z.enum(MACHINE_TYPES[kind]),
    head_count: z.coerce.number().int().min(1).max(200).default(1),
    needle_count: z.coerce.number().int().min(1).max(100).nullish(),
    no_of_colors: z.coerce.number().int().min(1).max(100).nullish(),
    capacity_stitches_hour: z.coerce.number().min(0).nullish(),
    capacity_per_hour: z.coerce.number().min(0).nullish(),
    capacity_uom: z.enum(['PCS', 'KG', 'MTR']).default('PCS'),
    setup_time_minutes: z.coerce.number().int().min(0).max(1440).nullish(),
    location: s.nullableStr(80),
    remarks: s.nullableStr(255),
    is_active: z.coerce.boolean().default(true),
    rate: rateSchema.optional(),
  }).superRefine((m, ctx) => {
    if (kind === 'EMBROIDERY' && !m.needle_count) ctx.addIssue({ code: 'custom', path: ['needle_count'], message: 'Needles per head is required' });
    if (kind === 'EMBROIDERY' && !(n(m.capacity_stitches_hour) > 0)) ctx.addIssue({ code: 'custom', path: ['capacity_stitches_hour'], message: 'Standard stitch capacity / hour is required' });
    if (kind === 'PRINTING' && !(n(m.capacity_per_hour) > 0)) ctx.addIssue({ code: 'custom', path: ['capacity_per_hour'], message: 'Standard output / hour is required' });
  });

  const machineRow = async (cid: number, id: number) => {
    const m = await machineOf(cid, kind, id);
    const rates = await query<any>(
      `SELECT r.*, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM trx_mp_costing c WHERE c.machine_rate_id = r.id AND c.is_final = 1) AS used_final
         FROM mst_mp_machine_rate r LEFT JOIN mst_user u ON u.id = r.created_by
        WHERE r.machine_id = ? ORDER BY r.effective_from DESC, r.id DESC`, [id]);
    return { ...m, rates, current_rate: rates.find((r) => String(r.effective_from) <= new Date().toISOString().slice(0, 10)) ?? null };
  };

  router.get('/machines', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['m.company_id = ?', 'm.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    if (req.query.active === '1') where.push('m.is_active = 1');
    if (req.query.q) { where.push('(m.machine_code LIKE ? OR m.machine_name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const rows = await query<any>(
      `SELECT m.*, r.id AS rate_id, r.effective_from, r.costing_method, r.rate_basis, r.machine_hour_rate, r.depreciation_rate_hour,
              r.electricity_rate_hour, r.maintenance_rate_hour, r.overhead_basis, r.overhead_rate_hour, r.overhead_pct,
              r.operator_rate_hour, r.helper_rate_hour
         FROM mst_mp_machine m
         LEFT JOIN mst_mp_machine_rate r ON r.id = (SELECT r2.id FROM mst_mp_machine_rate r2 WHERE r2.machine_id = m.id AND r2.effective_from <= CURDATE()
                                                     ORDER BY r2.effective_from DESC, r2.id DESC LIMIT 1)
        WHERE ${where.join(' AND ')} ORDER BY m.is_active DESC, m.machine_code`, params);
    res.json({ data: rows });
  }));

  router.get('/machines/:id', requirePermission(P('VIEW')), ah(async (req, res) => {
    res.json({ data: await machineRow(req.user!.companyId, Number(req.params.id)) });
  }));

  router.post('/machines', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = machineSchema.parse(req.body);
    if (!b.rate) throw BadRequest('Give the machine rates (effective from, method and hourly rates)');
    const id = await transaction(async (tx) => {
      const dup = await txQueryOne(tx, `SELECT id FROM mst_mp_machine WHERE company_id = ? AND process_kind = ? AND machine_code = ?`, [cid, kind, b.machine_code]);
      if (dup) throw BadRequest(`Machine code ${b.machine_code} already exists`);
      const r = await txExecute(tx,
        `INSERT INTO mst_mp_machine (company_id, process_kind, machine_code, machine_name, machine_type, head_count, needle_count, no_of_colors,
           capacity_stitches_hour, capacity_per_hour, capacity_uom, setup_time_minutes, location, remarks, is_active, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, kind, b.machine_code, b.machine_name, b.machine_type, b.head_count, b.needle_count ?? null, b.no_of_colors ?? null,
         b.capacity_stitches_hour ?? null, b.capacity_per_hour ?? null, b.capacity_uom, b.setup_time_minutes ?? null, b.location ?? null,
         b.remarks ?? null, b.is_active ? 1 : 0, req.user!.id]);
      await insertRate(tx, r.insertId, b.rate!, req.user!.id);
      await audit(req, 'mst_mp_machine', r.insertId, 'INSERT', undefined, { ...b }, tx);
      return r.insertId;
    });
    res.status(201).json({ data: await machineRow(cid, id) });
  }));

  router.put('/machines/:id', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = machineSchema.parse(req.body);
    const before = await machineOf(cid, kind, id);
    if (b.machine_code !== before.machine_code) {
      const dup = await queryOne(`SELECT id FROM mst_mp_machine WHERE company_id = ? AND process_kind = ? AND machine_code = ? AND id <> ?`, [cid, kind, b.machine_code, id]);
      if (dup) throw BadRequest(`Machine code ${b.machine_code} already exists`);
    }
    await transaction(async (tx) => {
      await txExecute(tx,
        `UPDATE mst_mp_machine SET machine_code = ?, machine_name = ?, machine_type = ?, head_count = ?, needle_count = ?, no_of_colors = ?,
           capacity_stitches_hour = ?, capacity_per_hour = ?, capacity_uom = ?, setup_time_minutes = ?, location = ?, remarks = ?, is_active = ?, updated_by = ?
         WHERE id = ?`,
        [b.machine_code, b.machine_name, b.machine_type, b.head_count, b.needle_count ?? null, b.no_of_colors ?? null,
         b.capacity_stitches_hour ?? null, b.capacity_per_hour ?? null, b.capacity_uom, b.setup_time_minutes ?? null, b.location ?? null,
         b.remarks ?? null, b.is_active ? 1 : 0, req.user!.id, id]);
      // A rate sent with the edit is a new effective-dated rate (never a silent change of history).
      if (b.rate) await insertRate(tx, id, b.rate, req.user!.id);
      await audit(req, 'mst_mp_machine', id, 'UPDATE', before, { ...b }, tx);
    });
    res.json({ data: await machineRow(cid, id) });
  }));

  /** POST /machines/:id/rates — a new rate from a date. A rate already used by an approved costing is never changed. */
  router.post('/machines/:id/rates', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    await machineOf(cid, kind, id);
    const b = rateSchema.parse(req.body);
    await transaction(async (tx) => {
      await insertRate(tx, id, b, req.user!.id);
      await audit(req, 'mst_mp_machine_rate', id, 'INSERT', undefined, b, tx);
    });
    res.status(201).json({ data: await machineRow(cid, id) });
  }));

  async function insertRate(tx: Tx, machineId: number, b: z.infer<typeof rateSchema>, userId: number) {
    const same = await txQueryOne<any>(tx, `SELECT id FROM mst_mp_machine_rate WHERE machine_id = ? AND effective_from = ? FOR UPDATE`, [machineId, b.effective_from]);
    if (same) {
      const used = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_mp_costing WHERE machine_rate_id = ? AND is_final = 1`, [same.id]);
      if (n(used?.c)) throw BadRequest(`The rate from ${b.effective_from} is already used by approved production — give a later effective date`);
      await txExecute(tx,
        `UPDATE mst_mp_machine_rate SET costing_method = ?, rate_basis = ?, machine_hour_rate = ?, depreciation_rate_hour = ?, electricity_rate_hour = ?,
           maintenance_rate_hour = ?, overhead_basis = ?, overhead_rate_hour = ?, overhead_pct = ?, operator_rate_hour = ?, helper_rate_hour = ?, remarks = ?
         WHERE id = ?`,
        [b.costing_method, b.rate_basis, b.machine_hour_rate, b.depreciation_rate_hour, b.electricity_rate_hour, b.maintenance_rate_hour,
         b.overhead_basis, b.overhead_rate_hour, b.overhead_pct, b.operator_rate_hour, b.helper_rate_hour, b.remarks ?? null, same.id]);
      return;
    }
    await txExecute(tx,
      `INSERT INTO mst_mp_machine_rate (machine_id, effective_from, costing_method, rate_basis, machine_hour_rate, depreciation_rate_hour,
         electricity_rate_hour, maintenance_rate_hour, overhead_basis, overhead_rate_hour, overhead_pct, operator_rate_hour, helper_rate_hour, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [machineId, b.effective_from, b.costing_method, b.rate_basis, b.machine_hour_rate, b.depreciation_rate_hour, b.electricity_rate_hour,
       b.maintenance_rate_hour, b.overhead_basis, b.overhead_rate_hour, b.overhead_pct, b.operator_rate_hour, b.helper_rate_hour, b.remarks ?? null, userId]);
  }

  // ================================================================= reasons
  router.get('/reasons', requirePermission(P('VIEW')), ah(async (req, res) => {
    const where = ['company_id = ?', 'process_kind = ?'];
    const params: unknown[] = [req.user!.companyId, kind];
    if (req.query.type) { where.push('reason_type = ?'); params.push(String(req.query.type)); }
    if (req.query.active === '1') where.push('is_active = 1');
    res.json({ data: await query(`SELECT * FROM mst_mp_reason WHERE ${where.join(' AND ')} ORDER BY reason_type, sort_order, reason_code`, params) });
  }));
  const reasonSchema = z.object({
    reason_type: z.enum(['DOWNTIME', 'REJECT']), reason_code: s.strReq(20), reason_name: s.strReq(120),
    needs_approval: z.coerce.boolean().default(false), sort_order: z.coerce.number().int().default(0), is_active: z.coerce.boolean().default(true),
  });
  router.post('/reasons', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = reasonSchema.parse(req.body);
    const dup = await queryOne(`SELECT id FROM mst_mp_reason WHERE company_id = ? AND process_kind = ? AND reason_type = ? AND reason_code = ?`, [cid, kind, b.reason_type, b.reason_code]);
    if (dup) throw BadRequest(`Reason code ${b.reason_code} already exists`);
    const r = await execute(`INSERT INTO mst_mp_reason (company_id, process_kind, reason_type, reason_code, reason_name, needs_approval, sort_order, is_active) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, kind, b.reason_type, b.reason_code, b.reason_name, b.needs_approval ? 1 : 0, b.sort_order, b.is_active ? 1 : 0]);
    await audit(req, 'mst_mp_reason', r.insertId, 'INSERT', undefined, b);
    res.status(201).json({ data: { id: r.insertId } });
  }));
  router.put('/reasons/:id', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = reasonSchema.parse(req.body);
    const before = await queryOne<any>(`SELECT * FROM mst_mp_reason WHERE id = ? AND company_id = ? AND process_kind = ?`, [id, cid, kind]);
    if (!before) throw NotFound('Reason not found');
    // The code is what history points to — it can be deactivated, not renamed, once used.
    if (b.reason_code !== before.reason_code) {
      const used = await queryOne<any>(`SELECT (SELECT COUNT(*) FROM trx_mp_downtime WHERE reason_id = ?) + (SELECT COUNT(*) FROM trx_mp_production_output WHERE reason_id = ?) c`, [id, id]);
      if (n(used?.c)) throw BadRequest('This reason is used on production entries — its code cannot change (deactivate it and add a new one)');
    }
    await query(`UPDATE mst_mp_reason SET reason_type = ?, reason_code = ?, reason_name = ?, needs_approval = ?, sort_order = ?, is_active = ? WHERE id = ?`,
      [b.reason_type, b.reason_code, b.reason_name, b.needs_approval ? 1 : 0, b.sort_order, b.is_active ? 1 : 0, id]);
    await audit(req, 'mst_mp_reason', id, 'UPDATE', before, b);
    res.json({ data: { id } });
  }));

  // ================================================================= designs / artwork
  const designSchema = z.object({
    design_code: s.strReq(40),
    design_name: s.strReq(150),
    style_id: s.id(), buyer_id: s.id(),
    file_url: s.nullableStr(300), file_name: s.nullableStr(200),
    total_stitches: z.coerce.number().int().min(0).max(100_000_000).nullish(),
    no_of_colors: z.coerce.number().int().min(0).max(100).nullish(),
    needle_sequence: s.nullableStr(255), hoop_size: s.nullableStr(60),
    std_minutes_per_pc: z.coerce.number().min(0).max(10000).nullish(),
    backing_type: s.nullableStr(60), print_type: s.nullableStr(40), placement: s.nullableStr(60),
    remarks: s.nullableStr(500),
    colors: z.array(z.object({
      needle_no: z.coerce.number().int().min(1).max(100).nullish(), color_name: s.strReq(80), trim_id: s.id(),
      stitches: z.coerce.number().int().min(0).nullish(),
    })).max(100).default([]),
  }).superRefine((d, ctx) => {
    if (kind === 'EMBROIDERY' && !(n(d.total_stitches) > 0)) ctx.addIssue({ code: 'custom', path: ['total_stitches'], message: 'Total stitches is required for an embroidery design' });
  });

  const designRow = async (cid: number, id: number) => {
    const d = await queryOne<any>(
      `SELECT d.*, st.style_code, st.style_name, p.party_name AS buyer_name, ua.full_name AS approved_by_name, uc.full_name AS created_by_name,
              (SELECT COUNT(*) FROM trx_mp_job j WHERE j.design_id = d.id) AS job_count
         FROM mst_mp_design d LEFT JOIN mst_style st ON st.id = d.style_id LEFT JOIN mst_party p ON p.id = d.buyer_id
         LEFT JOIN mst_user ua ON ua.id = d.approved_by LEFT JOIN mst_user uc ON uc.id = d.created_by
        WHERE d.id = ? AND d.company_id = ? AND d.process_kind = ?`, [id, cid, kind]);
    if (!d) throw NotFound(`${L} design not found`);
    d.colors = await query(`SELECT c.*, t.trim_code, t.trim_name FROM mst_mp_design_color c LEFT JOIN mst_trim t ON t.id = c.trim_id WHERE c.design_id = ? ORDER BY c.seq_no`, [id]);
    d.versions = await query(`SELECT id, version_no, status, approved_at FROM mst_mp_design WHERE company_id = ? AND process_kind = ? AND design_code = ? ORDER BY version_no DESC`, [cid, kind, d.design_code]);
    return d;
  };

  router.get('/designs', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['d.company_id = ?', 'd.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    if (req.query.status) { where.push('d.status = ?'); params.push(String(req.query.status)); }
    if (req.query.style_id) { where.push('(d.style_id = ? OR d.style_id IS NULL)'); params.push(Number(req.query.style_id)); }
    if (req.query.q) { where.push('(d.design_code LIKE ? OR d.design_name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.latest === '1') where.push('d.version_no = (SELECT MAX(d2.version_no) FROM mst_mp_design d2 WHERE d2.company_id = d.company_id AND d2.process_kind = d.process_kind AND d2.design_code = d.design_code)');
    const rows = await query(
      `SELECT d.*, st.style_code, p.party_name AS buyer_name FROM mst_mp_design d LEFT JOIN mst_style st ON st.id = d.style_id LEFT JOIN mst_party p ON p.id = d.buyer_id
        WHERE ${where.join(' AND ')} ORDER BY d.design_code, d.version_no DESC LIMIT 1000`, params);
    res.json({ data: rows });
  }));
  router.get('/designs/:id', requirePermission(P('VIEW')), ah(async (req, res) => {
    res.json({ data: await designRow(req.user!.companyId, Number(req.params.id)) });
  }));

  async function writeDesign(tx: Tx, id: number, b: z.infer<typeof designSchema>) {
    await txExecute(tx, `DELETE FROM mst_mp_design_color WHERE design_id = ?`, [id]);
    let seq = 0;
    for (const c of b.colors) {
      await txExecute(tx, `INSERT INTO mst_mp_design_color (design_id, seq_no, needle_no, color_name, trim_id, stitches) VALUES (?,?,?,?,?,?)`,
        [id, ++seq, c.needle_no ?? null, c.color_name, c.trim_id ?? null, c.stitches ?? null]);
    }
  }
  const designValues = (b: z.infer<typeof designSchema>) => [b.design_name, b.style_id ?? null, b.buyer_id ?? null, b.file_url ?? null, b.file_name ?? null,
    b.total_stitches ?? null, b.no_of_colors ?? (b.colors.length || null), b.needle_sequence ?? null, b.hoop_size ?? null, b.std_minutes_per_pc ?? null,
    b.backing_type ?? null, b.print_type ?? null, b.placement ?? null, b.remarks ?? null];

  router.post('/designs', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = designSchema.parse(req.body);
    const id = await transaction(async (tx) => {
      const dup = await txQueryOne(tx, `SELECT id FROM mst_mp_design WHERE company_id = ? AND process_kind = ? AND design_code = ?`, [cid, kind, b.design_code]);
      if (dup) throw BadRequest(`Design ${b.design_code} already exists — open it and make a new version`);
      const r = await txExecute(tx,
        `INSERT INTO mst_mp_design (company_id, process_kind, design_code, version_no, design_name, style_id, buyer_id, file_url, file_name, total_stitches,
           no_of_colors, needle_sequence, hoop_size, std_minutes_per_pc, backing_type, print_type, placement, remarks, created_by)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [cid, kind, b.design_code, ...designValues(b), req.user!.id]);
      await writeDesign(tx, r.insertId, b);
      await audit(req, 'mst_mp_design', r.insertId, 'INSERT', undefined, b, tx);
      return r.insertId;
    });
    res.status(201).json({ data: await designRow(cid, id) });
  }));

  router.put('/designs/:id', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = designSchema.parse(req.body);
    await transaction(async (tx) => {
      const before = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!before) throw NotFound(`${L} design not found`);
      if (before.status !== 'DRAFT') throw BadRequest(`Design ${before.design_code} v${before.version_no} is ${before.status} — make a new version to change it`);
      if (b.design_code !== before.design_code) throw BadRequest('The design code cannot change');
      await txExecute(tx,
        `UPDATE mst_mp_design SET design_name = ?, style_id = ?, buyer_id = ?, file_url = ?, file_name = ?, total_stitches = ?, no_of_colors = ?,
           needle_sequence = ?, hoop_size = ?, std_minutes_per_pc = ?, backing_type = ?, print_type = ?, placement = ?, remarks = ?, updated_by = ? WHERE id = ?`,
        [...designValues(b), req.user!.id, id]);
      await writeDesign(tx, id, b);
      await audit(req, 'mst_mp_design', id, 'UPDATE', before, b, tx);
    });
    res.json({ data: await designRow(cid, id) });
  }));

  router.post('/designs/:id/approve', requireAny(P('MASTER'), P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    await transaction(async (tx) => {
      const d = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!d) throw NotFound(`${L} design not found`);
      if (d.status !== 'DRAFT') throw BadRequest(`Design ${d.design_code} v${d.version_no} is already ${d.status}`);
      await txExecute(tx, `UPDATE mst_mp_design SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
      // The earlier approved version becomes obsolete (jobs already on it keep it).
      await txExecute(tx, `UPDATE mst_mp_design SET status = 'OBSOLETE' WHERE company_id = ? AND process_kind = ? AND design_code = ? AND id <> ? AND status = 'APPROVED'`,
        [cid, kind, d.design_code, id]);
      await audit(req, 'mst_mp_design', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED' }, tx);
    });
    res.json({ data: await designRow(cid, id) });
  }));

  router.post('/designs/:id/obsolete', requireAny(P('MASTER'), P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const d = await queryOne<any>(`SELECT * FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ?`, [id, cid, kind]);
    if (!d) throw NotFound(`${L} design not found`);
    if (d.status === 'OBSOLETE') throw BadRequest('Already obsolete');
    await query(`UPDATE mst_mp_design SET status = 'OBSOLETE', updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'mst_mp_design', id, 'UPDATE', { status: d.status }, { status: 'OBSOLETE' });
    res.json({ data: await designRow(cid, id) });
  }));

  /** POST /designs/:id/new-version — copy as the next DRAFT version (the approved one stays immutable). */
  router.post('/designs/:id/new-version', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const newId = await transaction(async (tx) => {
      const d = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ?`, [id, cid, kind]);
      if (!d) throw NotFound(`${L} design not found`);
      const draft = await txQueryOne<any>(tx, `SELECT version_no FROM mst_mp_design WHERE company_id = ? AND process_kind = ? AND design_code = ? AND status = 'DRAFT'`, [cid, kind, d.design_code]);
      if (draft) throw BadRequest(`Version ${draft.version_no} of ${d.design_code} is still a draft — edit that one`);
      const mx = await txQueryOne<any>(tx, `SELECT MAX(version_no) v FROM mst_mp_design WHERE company_id = ? AND process_kind = ? AND design_code = ? FOR UPDATE`, [cid, kind, d.design_code]);
      const r = await txExecute(tx,
        `INSERT INTO mst_mp_design (company_id, process_kind, design_code, version_no, design_name, style_id, buyer_id, file_url, file_name, total_stitches,
           no_of_colors, needle_sequence, hoop_size, std_minutes_per_pc, backing_type, print_type, placement, remarks, created_by)
         SELECT company_id, process_kind, design_code, ?, design_name, style_id, buyer_id, file_url, file_name, total_stitches, no_of_colors, needle_sequence,
                hoop_size, std_minutes_per_pc, backing_type, print_type, placement, remarks, ? FROM mst_mp_design WHERE id = ?`, [n(mx?.v) + 1, req.user!.id, id]);
      await txExecute(tx, `INSERT INTO mst_mp_design_color (design_id, seq_no, needle_no, color_name, trim_id, stitches)
                           SELECT ?, seq_no, needle_no, color_name, trim_id, stitches FROM mst_mp_design_color WHERE design_id = ?`, [r.insertId, id]);
      await audit(req, 'mst_mp_design', r.insertId, 'INSERT', undefined, { copied_from: id, version_no: n(mx?.v) + 1 }, tx);
      return r.insertId;
    });
    res.status(201).json({ data: await designRow(cid, newId) });
  }));

  // ================================================================= recipes
  const recipeSchema = z.object({
    recipe_no: s.nullableStr(40),
    recipe_name: s.strReq(150),
    design_id: s.id(),
    base_qty: z.coerce.number().positive().max(1e7).default(kind === 'PRINTING' ? 100 : 1),
    base_uom: z.enum(['PCS', 'KG', 'MTR']).default('PCS'),
    effective_from: s.date(),
    remarks: s.nullableStr(500),
    items: z.array(z.object({
      trim_id: s.idReq(),
      material_role: z.enum(ROLES[kind]),
      basis: z.enum(['PER_PIECE', 'PER_BASE', 'PER_1000_STITCH']),
      std_qty: z.coerce.number().positive('Standard qty must be more than 0').max(1e9),
      uom_id: s.idReq(),
      per_stock_unit: z.coerce.number().positive().max(1e9).nullish(),
      loss_pct: z.coerce.number().min(0).max(100).default(0),
      remarks: s.nullableStr(255),
    })).min(1, 'Add at least one material').max(60),
  }).superRefine((r, ctx) => {
    if (kind === 'PRINTING' && r.items.some((i) => i.basis === 'PER_1000_STITCH')) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Per 1,000 stitches is for embroidery only' });
  });

  const recipeRow = async (cid: number, id: number) => {
    const r = await queryOne<any>(
      `SELECT r.*, d.design_code, d.version_no AS design_version, d.total_stitches, d.status AS design_status, ua.full_name AS approved_by_name,
              (SELECT COUNT(*) FROM trx_mp_job j WHERE j.recipe_id = r.id) AS job_count
         FROM mst_mp_recipe r LEFT JOIN mst_mp_design d ON d.id = r.design_id LEFT JOIN mst_user ua ON ua.id = r.approved_by
        WHERE r.id = ? AND r.company_id = ? AND r.process_kind = ?`, [id, cid, kind]);
    if (!r) throw NotFound(`${L} recipe not found`);
    r.items = await query(
      `SELECT i.*, t.trim_code, t.trim_name, t.trim_type, t.std_rate, t.base_uom, u.code AS uom_code, bu.code AS stock_uom_code
         FROM mst_mp_recipe_item i JOIN mst_trim t ON t.id = i.trim_id LEFT JOIN cfg_uom u ON u.id = i.uom_id LEFT JOIN cfg_uom bu ON bu.id = t.base_uom
        WHERE i.recipe_id = ? ORDER BY i.seq_no, i.id`, [id]);
    r.versions = await query(`SELECT id, version_no, status, approved_at FROM mst_mp_recipe WHERE company_id = ? AND process_kind = ? AND recipe_no = ? ORDER BY version_no DESC`, [cid, kind, r.recipe_no]);
    return r;
  };

  async function checkRecipeRefs(cid: number, b: z.infer<typeof recipeSchema>) {
    if (b.design_id) {
      const d = await queryOne(`SELECT id FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ?`, [b.design_id, cid, kind]);
      if (!d) throw BadRequest('Design not found');
    }
    const trims = await query<any>(`SELECT id FROM mst_trim WHERE company_id = ? AND id IN (?) AND is_deleted = 0`, [cid, b.items.map((i) => i.trim_id)]);
    if (trims.length !== new Set(b.items.map((i) => i.trim_id)).size) throw BadRequest('A material on the recipe was not found');
    // consumption UOM → stock UOM factor resolved (and fixed) when the recipe is saved
    return Promise.all(b.items.map(async (i) => ({ ...i, per_stock_unit: await stockFactor(i.trim_id, i.uom_id, i.per_stock_unit) })));
  }
  async function writeItems(tx: Tx, id: number, items: Awaited<ReturnType<typeof checkRecipeRefs>>) {
    await txExecute(tx, `DELETE FROM mst_mp_recipe_item WHERE recipe_id = ?`, [id]);
    let seq = 0;
    for (const i of items) {
      seq += 10;
      await txExecute(tx,
        `INSERT INTO mst_mp_recipe_item (recipe_id, seq_no, trim_id, material_role, basis, std_qty, uom_id, per_stock_unit, loss_pct, remarks) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, seq, i.trim_id, i.material_role, i.basis, i.std_qty, i.uom_id, i.per_stock_unit, i.loss_pct, i.remarks ?? null]);
    }
  }

  router.get('/recipes', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['r.company_id = ?', 'r.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    if (req.query.status) { where.push('r.status = ?'); params.push(String(req.query.status)); }
    if (req.query.design_id) { where.push('(r.design_id = ? OR r.design_id IS NULL)'); params.push(Number(req.query.design_id)); }
    if (req.query.q) { where.push('(r.recipe_no LIKE ? OR r.recipe_name LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const rows = await query(
      `SELECT r.*, d.design_code, d.version_no AS design_version, (SELECT COUNT(*) FROM mst_mp_recipe_item i WHERE i.recipe_id = r.id) AS item_count
         FROM mst_mp_recipe r LEFT JOIN mst_mp_design d ON d.id = r.design_id
        WHERE ${where.join(' AND ')} ORDER BY r.recipe_no, r.version_no DESC LIMIT 1000`, params);
    res.json({ data: rows });
  }));
  router.get('/recipes/:id', requirePermission(P('VIEW')), ah(async (req, res) => {
    res.json({ data: await recipeRow(req.user!.companyId, Number(req.params.id)) });
  }));

  /** GET /recipes/:id/requirement?qty=&stitches_per_pc= — standard material requirement for a qty. */
  router.get('/recipes/:id/requirement', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const q = z.object({ qty: z.coerce.number().min(0), stitches_per_pc: z.coerce.number().min(0).optional() }).parse(req.query);
    const r = await recipeRow(cid, Number(req.params.id));
    const spp = q.stitches_per_pc ?? (r.total_stitches ? n(r.total_stitches) : null);
    if (r.items.some((i: any) => i.basis === 'PER_1000_STITCH') && !spp) throw BadRequest('Stitches per piece is needed for per-1,000-stitch lines');
    const lines = calculateStandardConsumption(r.items.map((i: any) => ({ ...i, std_qty: n(i.std_qty), loss_pct: n(i.loss_pct), per_stock_unit: n(i.per_stock_unit) })),
      q.qty, n(r.base_qty), spp);
    res.json({ data: lines.map((l: any) => ({ ...l, stock_qty: r6(l.standard_qty / (n(l.per_stock_unit) || 1)), std_cost: r6(l.standard_qty / (n(l.per_stock_unit) || 1) * n(l.std_rate)) })) });
  }));

  router.post('/recipes', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = recipeSchema.parse(req.body);
    const items = await checkRecipeRefs(cid, b);
    const id = await transaction(async (tx) => {
      const no = b.recipe_no || await nextDocNumber(tx, cid, DOC[kind].recipe);
      const dup = await txQueryOne(tx, `SELECT id FROM mst_mp_recipe WHERE company_id = ? AND process_kind = ? AND recipe_no = ?`, [cid, kind, no]);
      if (dup) throw BadRequest(`Recipe ${no} already exists — open it and make a new version`);
      const r = await txExecute(tx,
        `INSERT INTO mst_mp_recipe (company_id, process_kind, recipe_no, version_no, recipe_name, design_id, base_qty, base_uom, effective_from, remarks, created_by)
         VALUES (?,?,?,1,?,?,?,?,?,?,?)`,
        [cid, kind, no, b.recipe_name, b.design_id ?? null, b.base_qty, b.base_uom, b.effective_from ?? null, b.remarks ?? null, req.user!.id]);
      await writeItems(tx, r.insertId, items);
      await audit(req, 'mst_mp_recipe', r.insertId, 'INSERT', undefined, { ...b, recipe_no: no }, tx);
      return r.insertId;
    });
    res.status(201).json({ data: await recipeRow(cid, id) });
  }));

  router.put('/recipes/:id', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = recipeSchema.parse(req.body);
    const items = await checkRecipeRefs(cid, b);
    await transaction(async (tx) => {
      const before = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_recipe WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!before) throw NotFound(`${L} recipe not found`);
      if (before.status !== 'DRAFT') throw BadRequest(`Recipe ${before.recipe_no} v${before.version_no} is ${before.status} — make a new version to change it`);
      await txExecute(tx,
        `UPDATE mst_mp_recipe SET recipe_name = ?, design_id = ?, base_qty = ?, base_uom = ?, effective_from = ?, remarks = ?, updated_by = ? WHERE id = ?`,
        [b.recipe_name, b.design_id ?? null, b.base_qty, b.base_uom, b.effective_from ?? null, b.remarks ?? null, req.user!.id, id]);
      await writeItems(tx, id, items);
      await audit(req, 'mst_mp_recipe', id, 'UPDATE', before, b, tx);
    });
    res.json({ data: await recipeRow(cid, id) });
  }));

  router.post('/recipes/:id/approve', requireAny(P('MASTER'), P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    await transaction(async (tx) => {
      const r = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_recipe WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!r) throw NotFound(`${L} recipe not found`);
      if (r.status !== 'DRAFT') throw BadRequest(`Recipe ${r.recipe_no} v${r.version_no} is already ${r.status}`);
      const items = await txQuery<any>(tx, `SELECT COUNT(*) c FROM mst_mp_recipe_item WHERE recipe_id = ?`, [id]);
      if (!n(items[0]?.c)) throw BadRequest('A recipe needs at least one material');
      await txExecute(tx, `UPDATE mst_mp_recipe SET status = 'APPROVED', approved_by = ?, approved_at = NOW(), effective_from = COALESCE(effective_from, CURDATE()) WHERE id = ?`, [req.user!.id, id]);
      await txExecute(tx, `UPDATE mst_mp_recipe SET status = 'OBSOLETE' WHERE company_id = ? AND process_kind = ? AND recipe_no = ? AND id <> ? AND status = 'APPROVED'`, [cid, kind, r.recipe_no, id]);
      await audit(req, 'mst_mp_recipe', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED' }, tx);
    });
    res.json({ data: await recipeRow(cid, id) });
  }));

  router.post('/recipes/:id/obsolete', requireAny(P('MASTER'), P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const r = await queryOne<any>(`SELECT * FROM mst_mp_recipe WHERE id = ? AND company_id = ? AND process_kind = ?`, [id, cid, kind]);
    if (!r) throw NotFound(`${L} recipe not found`);
    if (r.status === 'OBSOLETE') throw BadRequest('Already obsolete');
    await query(`UPDATE mst_mp_recipe SET status = 'OBSOLETE', updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'mst_mp_recipe', id, 'UPDATE', { status: r.status }, { status: 'OBSOLETE' });
    res.json({ data: await recipeRow(cid, id) });
  }));

  router.post('/recipes/:id/new-version', requirePermission(P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const newId = await transaction(async (tx) => {
      const r = await txQueryOne<any>(tx, `SELECT * FROM mst_mp_recipe WHERE id = ? AND company_id = ? AND process_kind = ?`, [id, cid, kind]);
      if (!r) throw NotFound(`${L} recipe not found`);
      const draft = await txQueryOne<any>(tx, `SELECT version_no FROM mst_mp_recipe WHERE company_id = ? AND process_kind = ? AND recipe_no = ? AND status = 'DRAFT'`, [cid, kind, r.recipe_no]);
      if (draft) throw BadRequest(`Version ${draft.version_no} of ${r.recipe_no} is still a draft — edit that one`);
      const mx = await txQueryOne<any>(tx, `SELECT MAX(version_no) v FROM mst_mp_recipe WHERE company_id = ? AND process_kind = ? AND recipe_no = ? FOR UPDATE`, [cid, kind, r.recipe_no]);
      const ins = await txExecute(tx,
        `INSERT INTO mst_mp_recipe (company_id, process_kind, recipe_no, version_no, recipe_name, design_id, base_qty, base_uom, effective_from, remarks, created_by)
         SELECT company_id, process_kind, recipe_no, ?, recipe_name, design_id, base_qty, base_uom, NULL, remarks, ? FROM mst_mp_recipe WHERE id = ?`, [n(mx?.v) + 1, req.user!.id, id]);
      await txExecute(tx,
        `INSERT INTO mst_mp_recipe_item (recipe_id, seq_no, trim_id, material_role, basis, std_qty, uom_id, per_stock_unit, loss_pct, remarks)
         SELECT ?, seq_no, trim_id, material_role, basis, std_qty, uom_id, per_stock_unit, loss_pct, remarks FROM mst_mp_recipe_item WHERE recipe_id = ?`, [ins.insertId, id]);
      await audit(req, 'mst_mp_recipe', ins.insertId, 'INSERT', undefined, { copied_from: id, version_no: n(mx?.v) + 1 }, tx);
      return ins.insertId;
    });
    res.status(201).json({ data: await recipeRow(cid, newId) });
  }));

  /** Materials usable on a recipe: trims of the matching types first (thread / backing … or dyes / chemicals …). */
  router.get('/materials', requirePermission(P('VIEW')), ah(async (req, res) => {
    const pref = kind === 'EMBROIDERY' ? ['THREAD', 'BOBBIN_THREAD', 'BACKING', 'TOPPING', 'ADHESIVE', 'NEEDLE', 'TAPE']
      : ['DYE', 'PIGMENT', 'INK', 'BINDER', 'CHEMICAL'];
    const rows = await query<any>(
      `SELECT t.id, t.trim_code AS code, t.trim_name AS label, t.trim_type, t.base_uom, u.code AS uom_code, t.std_rate,
              COALESCE((SELECT SUM(ts.stock_qty - ts.allocated_qty) FROM trx_trim_stock ts WHERE ts.trim_id = t.id AND ts.company_id = t.company_id), 0) AS stock_qty
         FROM mst_trim t LEFT JOIN cfg_uom u ON u.id = t.base_uom
        WHERE t.company_id = ? AND t.is_active = 1 AND t.is_deleted = 0
        ORDER BY (t.trim_type IN (?)) DESC, t.trim_name`, [req.user!.companyId, pref]);
    res.json({ data: rows.map((r) => ({ ...r, preferred: pref.includes(r.trim_type) })) });
  }));
}
