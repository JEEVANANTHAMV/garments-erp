/**
 * Company provisioning: copy the configuration a NEW company needs from an existing (source) company.
 *
 * Called inside the caller's transaction right after the mst_company row (and, in POST /admin/companies, the HO branch,
 * roles, base number series and user grants) are inserted. Everything here is idempotent — each INSERT is guarded by
 * NOT EXISTS on the table's business key — so calling it twice, or after the re-runnable migrations have already added
 * rows for the new company, never duplicates anything.
 *
 * Copies configuration and reference lists only. Never copies trx_* data, stock, parties or materials. Rows that point
 * at another company's masters are re-mapped by business code (unit_code, stage_code, role_code, warehouse_code …);
 * a reference that cannot be mapped is left NULL (or the row is skipped when the column is NOT NULL).
 */
import { txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';

export interface ProvisionOptions {
  copyMasters?: {
    tax?: boolean; ledger?: boolean; colors?: boolean; sizeGroups?: boolean;
    gsm?: boolean; dia?: boolean; yarnCounts?: boolean; compositions?: boolean;
  };
}

/** Per-table count of rows inserted by this call (0 = already present / nothing in the source). */
export type ProvisionSummary = Record<string, number>;

function int(n: number, what: string): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`provisionCompany: invalid ${what} ${n}`);
  return n;
}

export async function provisionCompany(
  tx: Tx, newCid: number, srcCid: number, userId: number, opts: ProvisionOptions = {},
): Promise<Record<string, number>> {
  const N = int(newCid, 'newCid'); const S = int(srcCid, 'srcCid'); const U = int(userId, 'userId');
  if (N === S) throw new Error('provisionCompany: source and new company are the same');
  const m = opts.copyMasters ?? {};
  const out: ProvisionSummary = {};

  // Real columns per table (copy lists are intersected with these so an optional column missing on an older schema
  // never breaks provisioning; tables that do not exist are skipped).
  const colRows = await txQuery<{ t: string; c: string }>(tx,
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const cols = new Map<string, Set<string>>();
  for (const r of colRows) { if (!cols.has(r.t)) cols.set(r.t, new Set()); cols.get(r.t)!.add(r.c); }
  const has = (t: string) => cols.has(t);

  const add = (k: string, n: number) => { out[k] = (out[k] ?? 0) + n; };
  const run = async (key: string, sql: string, params: unknown[] = []) => {
    const r = await txExecute(tx, sql, params);
    add(key, r.affectedRows);
  };

  /**
   * INSERT INTO t (company_id, …cols) SELECT newCid, … FROM t s WHERE s.company_id = srcCid AND NOT EXISTS (same key in
   * the new company). `expr` overrides the SELECT expression of a column (alias `s` = source row); `where` filters
   * source rows.
   */
  const copy = async (table: string, colList: string[], keys: string[], o: {
    expr?: Record<string, string>; where?: string; key?: string;
  } = {}) => {
    if (!has(table)) return;
    const real = cols.get(table)!;
    const list = colList.filter((c) => real.has(c));
    const e = (c: string) => o.expr?.[c] ?? `s.\`${c}\``;
    const keyCond = keys.map((k) => `x.\`${k}\` <=> ${e(k)}`).join(' AND ');
    await run(o.key ?? table,
      `INSERT INTO \`${table}\` (company_id, ${list.map((c) => `\`${c}\``).join(', ')})
       SELECT ${N}, ${list.map(e).join(', ')}
         FROM \`${table}\` s
        WHERE s.company_id = ${S}${o.where ? ` AND (${o.where})` : ''}
          AND NOT EXISTS (SELECT 1 FROM \`${table}\` x WHERE x.company_id = ${N} AND ${keyCond})`);
  };

  const co = await txQueryOne<{ legal_name: string; trade_name: string | null }>(tx,
    `SELECT legal_name, trade_name FROM mst_company WHERE id = ?`, [N]);
  if (!co) throw new Error(`provisionCompany: company ${N} not found`);
  const src = await txQueryOne(tx, `SELECT id FROM mst_company WHERE id = ?`, [S]);
  if (!src) throw new Error(`provisionCompany: source company ${S} not found`);

  // ---------------------------------------------------------------- branch / units / FY
  let ho = await txQueryOne<{ id: number }>(tx,
    `SELECT id FROM mst_branch WHERE company_id = ? AND is_head_office = 1 AND is_deleted = 0 ORDER BY id LIMIT 1`, [N]);
  if (!ho) {
    await run('mst_branch',
      `INSERT INTO mst_branch (company_id, branch_code, branch_name, gstin, address_line1, city, state, pincode, phone, is_head_office, created_by)
       SELECT id, 'HO', 'Head Office', gstin, address_line1, city, state, pincode, phone, 1, ? FROM mst_company c
        WHERE c.id = ? AND NOT EXISTS (SELECT 1 FROM mst_branch b WHERE b.company_id = c.id AND b.branch_code = 'HO')`, [U, N]);
    ho = await txQueryOne<{ id: number }>(tx,
      `SELECT id FROM mst_branch WHERE company_id = ? ORDER BY is_head_office DESC, id LIMIT 1`, [N]);
  }
  const HO = int(Number(ho!.id), 'HO branch');

  // Units: branch re-mapped by branch_code, else the new HO.
  await copy('mst_unit',
    ['branch_id', 'unit_code', 'unit_name', 'unit_type', 'capacity_per_day', 'city', 'is_active', 'created_by'],
    ['unit_code'], {
      where: 's.is_deleted = 0',
      expr: {
        branch_id: `COALESCE((SELECT nb.id FROM mst_branch sb JOIN mst_branch nb ON nb.branch_code = sb.branch_code AND nb.company_id = ${N}
                                WHERE sb.id = s.branch_id LIMIT 1), ${HO})`,
        created_by: `${U}`,
      },
    });
  const unitMap = (col: string) =>
    `(SELECT nu.id FROM mst_unit su JOIN mst_unit nu ON nu.unit_code = su.unit_code AND nu.company_id = ${N} WHERE su.id = s.\`${col}\` LIMIT 1)`;

  // Current financial year (same dates as the source). Marked current only if the new company has none yet.
  const newHasCurrent = await txQueryOne(tx, `SELECT id FROM mst_financial_year WHERE company_id = ? AND is_current = 1 LIMIT 1`, [N]);
  await copy('mst_financial_year', ['fy_code', 'start_date', 'end_date', 'is_current', 'is_closed'], ['fy_code'], {
    where: 's.is_current = 1',
    expr: { is_current: newHasCurrent ? '0' : '1', is_closed: '0' },
  });

  // ---------------------------------------------------------------- roles (no-op when the caller already cloned them)
  await copy('mst_role', ['role_code', 'role_name', 'description', 'is_system', 'is_active'], ['role_code']);
  await run('map_role_permission',
    `INSERT INTO map_role_permission (role_id, permission_id)
     SELECT nr.id, rp.permission_id
       FROM map_role_permission rp
       JOIN mst_role sr ON sr.id = rp.role_id AND sr.company_id = ${S}
       JOIN mst_role nr ON nr.role_code = sr.role_code AND nr.company_id = ${N}
      WHERE NOT EXISTS (SELECT 1 FROM map_role_permission x WHERE x.role_id = nr.id AND x.permission_id = rp.permission_id)`);
  const roleMap = (col: string) =>
    `(SELECT nr.id FROM mst_role sr JOIN mst_role nr ON nr.role_code = sr.role_code AND nr.company_id = ${N} WHERE sr.id = s.\`${col}\` LIMIT 1)`;
  if (has('cfg_role_menu')) {
    await run('cfg_role_menu',
      `INSERT INTO cfg_role_menu (company_id, role_id, path, mode, updated_by)
       SELECT ${N}, nr.id, s.path, s.mode, ${U}
         FROM cfg_role_menu s
         JOIN mst_role sr ON sr.id = s.role_id
         JOIN mst_role nr ON nr.role_code = sr.role_code AND nr.company_id = ${N}
        WHERE s.company_id = ${S}
          AND NOT EXISTS (SELECT 1 FROM cfg_role_menu x WHERE x.company_id = ${N} AND x.role_id = nr.id AND x.path = s.path)`);
  }

  // ---------------------------------------------------------------- number series & settings
  // Company-wide series (branch / FY NULL) for every doc_type the source has; next_number restarts at 1.
  await copy('cfg_number_series', ['branch_id', 'doc_type', 'fy_id', 'prefix', 'suffix', 'next_number', 'padding'],
    ['branch_id', 'doc_type', 'fy_id'], {
      // JW_INV_DIV_<division id> series belong to the source's divisions — created per NEW division further down.
      where: `s.branch_id IS NULL AND s.fy_id IS NULL AND s.doc_type NOT LIKE 'JW\\_INV\\_DIV\\_%'`,
      expr: { next_number: '1' },
    });
  // Branch / FY specific series: only when both references map (branch by code, FY by fy_code).
  const branchMapS = `(SELECT nb.id FROM mst_branch sb JOIN mst_branch nb ON nb.branch_code = sb.branch_code AND nb.company_id = ${N} WHERE sb.id = s.branch_id LIMIT 1)`;
  const fyMapS = `(SELECT nf.id FROM mst_financial_year sf JOIN mst_financial_year nf ON nf.fy_code = sf.fy_code AND nf.company_id = ${N} WHERE sf.id = s.fy_id LIMIT 1)`;
  await copy('cfg_number_series', ['branch_id', 'doc_type', 'fy_id', 'prefix', 'suffix', 'next_number', 'padding'],
    ['branch_id', 'doc_type', 'fy_id'], {
      key: 'cfg_number_series',
      where: `(s.branch_id IS NOT NULL OR s.fy_id IS NOT NULL)
              AND (s.branch_id IS NULL OR ${branchMapS} IS NOT NULL)
              AND (s.fy_id IS NULL OR ${fyMapS} IS NOT NULL)`,
      expr: {
        branch_id: `IF(s.branch_id IS NULL, NULL, ${branchMapS})`,
        fy_id: `IF(s.fy_id IS NULL, NULL, ${fyMapS})`,
        next_number: '1',
      },
    });
  await copy('cfg_system_setting', ['setting_key', 'setting_value', 'description', 'is_editable'], ['setting_key']);

  // ---------------------------------------------------------------- warehouses
  await copy('mst_warehouse', ['unit_id', 'warehouse_code', 'warehouse_name', 'warehouse_type', 'is_active'],
    ['warehouse_code'], { expr: { unit_id: unitMap('unit_id') } });
  if (has('mst_warehouse_bin')) {
    await run('mst_warehouse_bin',
      `INSERT INTO mst_warehouse_bin (warehouse_id, bin_code, rack, is_active)
       SELECT nw.id, b.bin_code, b.rack, b.is_active
         FROM mst_warehouse_bin b
         JOIN mst_warehouse sw ON sw.id = b.warehouse_id AND sw.company_id = ${S}
         JOIN mst_warehouse nw ON nw.warehouse_code = sw.warehouse_code AND nw.company_id = ${N}
        WHERE NOT EXISTS (SELECT 1 FROM mst_warehouse_bin x WHERE x.warehouse_id = nw.id AND x.bin_code = b.bin_code)`);
  }

  // ---------------------------------------------------------------- process stages & operations
  await copy('cfg_process_stage',
    ['stage_code', 'stage_name', 'sort_order', 'is_outsourceable', 'is_active', 'bill_include_mistake', 'loss_tolerance_pct'],
    ['stage_code']);
  if (has('mst_process_operation')) {
    await run('mst_process_operation',
      `INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, default_rate, sort_order, is_active)
       SELECT ${N}, ns.id, s.op_code, s.op_name, s.default_rate, s.sort_order, s.is_active
         FROM mst_process_operation s
         JOIN cfg_process_stage ss ON ss.id = s.stage_id
         JOIN cfg_process_stage ns ON ns.stage_code = ss.stage_code AND ns.company_id = ${N}
        WHERE s.company_id = ${S}
          AND NOT EXISTS (SELECT 1 FROM mst_process_operation x WHERE x.company_id = ${N} AND x.op_code = s.op_code)`);
  }
  // Process routes not tied to a specific yarn / fabric (those reference the source company's materials).
  await copy('mst_process_route', ['route_code', 'route_name', 'yarn_id', 'fabric_id', 'remarks', 'is_active', 'created_by'],
    ['route_code'], { where: 's.yarn_id IS NULL AND s.fabric_id IS NULL', expr: { created_by: `${U}` } });
  if (has('mst_process_route_line')) {
    await run('mst_process_route_line',
      `INSERT INTO mst_process_route_line (route_id, seq_no, process_type, is_mandatory, default_loss_pct, allowed_unit, is_active)
       SELECT nr.id, l.seq_no, l.process_type, l.is_mandatory, l.default_loss_pct, l.allowed_unit, l.is_active
         FROM mst_process_route_line l
         JOIN mst_process_route sr ON sr.id = l.route_id AND sr.company_id = ${S}
         JOIN mst_process_route nr ON nr.route_code = sr.route_code AND nr.company_id = ${N}
        WHERE NOT EXISTS (SELECT 1 FROM mst_process_route_line x WHERE x.route_id = nr.id)`);
  }

  // ---------------------------------------------------------------- divisions (billing identity of the NEW company;
  // the source's GSTIN / address / bank overrides are deliberately not copied — blank means "use the company's")
  const billName = (co.trade_name || co.legal_name).replace(/'/g, "''");
  await copy('mst_division',
    ['division_code', 'division_name', 'billing_name', 'process_type', 'invoice_prefix', 'remarks', 'is_active', 'created_by'],
    ['division_code'], {
      where: 's.is_deleted = 0',
      expr: { billing_name: `LEFT(CONCAT('${billName}', ' - ', s.division_name), 200)`, created_by: `${U}` },
    });

  // One invoice number series per division (same rule as migration 63: JW_INV_DIV_<id>, prefix = invoice_prefix or code-).
  await run('cfg_number_series',
    `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
     SELECT d.company_id, NULL, CONCAT('JW_INV_DIV_', d.id), NULL, COALESCE(NULLIF(d.invoice_prefix, ''), CONCAT(d.division_code, '-')), 1, 5
       FROM mst_division d
      WHERE d.company_id = ${N}
        AND NOT EXISTS (SELECT 1 FROM cfg_number_series n WHERE n.company_id = d.company_id AND n.doc_type = CONCAT('JW_INV_DIV_', d.id))`);

  // ---------------------------------------------------------------- reference lists
  await copy('mst_defect', ['defect_code', 'defect_name', 'defect_type', 'stage', 'is_active'], ['defect_code']);
  await copy('mst_certificate_type', ['cert_code', 'cert_name', 'issuing_body', 'is_active'], ['cert_code']);
  await copy('cfg_package_type', ['type_code', 'type_name', 'prefix', 'is_active'], ['type_code']);
  await copy('cfg_shipment_doc_type',
    ['doc_code', 'doc_name', 'domestic_allowed', 'export_allowed', 'is_mandatory', 'sort_order', 'is_active'], ['doc_code']);
  await copy('mst_material_attr', ['attr_type', 'attr_value', 'sort_order', 'is_active', 'created_by'],
    ['attr_type', 'attr_value'], { expr: { created_by: `${U}` } });
  await copy('mst_material_category', ['parent_id', 'category_code', 'category_name', 'material_type', 'is_active'],
    ['category_code'], { expr: { parent_id: 'NULL' } });
  if (has('mst_material_category')) {
    await txExecute(tx,
      `UPDATE mst_material_category n
         JOIN mst_material_category s  ON s.company_id = ${S} AND s.category_code = n.category_code AND s.parent_id IS NOT NULL
         JOIN mst_material_category sp ON sp.id = s.parent_id
         JOIN mst_material_category np ON np.company_id = ${N} AND np.category_code = sp.category_code
          SET n.parent_id = np.id
        WHERE n.company_id = ${N} AND n.parent_id IS NULL`);
  }
  await copy('mst_fabric_process_type',
    ['code', 'name', 'output_state', 'changes_colour', 'allow_reprocess', 'allow_split', 'is_reprocess', 'sort_order', 'is_active', 'requires_qc'],
    ['code']);
  await copy('mst_fabric_process_reason', ['code', 'reason', 'kind', 'default_billing', 'is_active'], ['code']);
  await copy('mst_fabric_process_qc_param',
    ['process_code', 'param_name', 'uom', 'min_value', 'max_value', 'target_value', 'is_mandatory', 'sort_order', 'is_active'],
    ['process_code', 'param_name']);
  await copy('mst_yarn_process_type',
    ['code', 'name', 'base_process', 'process_mode', 'changes_shade', 'default_ply', 'ply_options', 'loss_tolerance_pct',
      'requires_qc', 'allow_reprocess', 'is_reprocess', 'billable', 'sort_order', 'is_active'], ['code']);
  await copy('mst_mp_reason',
    ['process_kind', 'reason_type', 'reason_code', 'reason_name', 'needs_approval', 'sort_order', 'is_active'],
    ['process_kind', 'reason_type', 'reason_code']);
  await copy('mst_dia_width_rule',
    ['rule_code', 'fabric_form', 'dia_definition', 'formula_type', 'factor', 'effective_from', 'effective_to',
      'approval_status', 'approved_by', 'approved_at', 'is_active', 'remarks', 'created_by'],
    ['rule_code'], { expr: { created_by: `${U}` } });
  await copy('cfg_shift', ['shift_code', 'shift_name', 'start_time', 'end_time', 'break_minutes', 'is_active'], ['shift_code']);
  await copy('cfg_delay_reason', ['reason_code', 'reason_name', 'category', 'is_active'], ['reason_code']);
  await copy('cfg_sewing_operation_master', ['operation_code', 'operation_name', 'smv', 'sort_order', 'is_active'], ['operation_code']);

  // ---------------------------------------------------------------- calendar / holidays / T&A
  await copy('cfg_working_calendar', ['day_of_week', 'day_name', 'is_working_day', 'standard_hours'], ['day_of_week']);
  await copy('cfg_holiday', ['holiday_date', 'holiday_name', 'is_optional'], ['holiday_date']);
  await copy('mst_tna_activity',
    ['activity_code', 'activity_name', 'category', 'default_duration', 'lead_time_type', 'department_name',
      'default_owner_role', 'dependency_type', 'mandatory', 'weight', 'alert_before_days', 'active'],
    ['activity_code']);
  await copy('mst_tna_template_header',
    ['template_code', 'template_name', 'product_type', 'description', 'active', 'created_by'],
    ['template_code'], { expr: { created_by: `${U}` } });
  if (has('mst_tna_template_activity')) {
    // Lines only into a new template that has none yet (never re-adds lines the company removed).
    await run('mst_tna_template_activity',
      `INSERT INTO mst_tna_template_activity
         (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name,
          default_owner_role, dependency_sequence, dependency_type, mandatory, weight, alert_before_days, active)
       SELECT nt.id, a.activity_code, a.activity_name, a.category, a.sequence_no, a.default_duration, a.duration_uom,
              a.department_name, a.default_owner_role, a.dependency_sequence, a.dependency_type, a.mandatory, a.weight,
              a.alert_before_days, a.active
         FROM mst_tna_template_activity a
         JOIN mst_tna_template_header st ON st.id = a.template_id AND st.company_id = ${S}
         JOIN mst_tna_template_header nt ON nt.template_code = st.template_code AND nt.company_id = ${N}
        WHERE NOT EXISTS (SELECT 1 FROM mst_tna_template_activity x WHERE x.template_id = nt.id)
          AND a.id = (SELECT MIN(d.id) FROM mst_tna_template_activity d
                       WHERE d.template_id = a.template_id AND d.sequence_no = a.sequence_no)`);
  }

  // ---------------------------------------------------------------- approval workflows
  await copy('cfg_workflow', ['doc_type', 'workflow_name', 'is_active'], ['doc_type']);
  if (has('cfg_workflow_step')) {
    await run('cfg_workflow_step',
      `INSERT INTO cfg_workflow_step (workflow_id, step_order, step_name, approver_role, min_amount, max_amount, is_final)
       SELECT nw.id, s.step_order, s.step_name, ${roleMap('approver_role')}, s.min_amount, s.max_amount, s.is_final
         FROM cfg_workflow_step s
         JOIN cfg_workflow sw ON sw.id = s.workflow_id AND sw.company_id = ${S}
         JOIN cfg_workflow nw ON nw.doc_type = sw.doc_type AND nw.company_id = ${N}
        WHERE NOT EXISTS (SELECT 1 FROM cfg_workflow_step x WHERE x.workflow_id = nw.id AND x.step_order = s.step_order)`);
  }

  // ---------------------------------------------------------------- production line definitions (unit by unit_code)
  const lineCols = ['line_code', 'line_name', 'unit_id', 'floor_name', 'supervisor_name', 'capacity_pcs', 'manpower',
    'working_hours', 'sam_per_pcs', 'efficiency_pct', 'is_active'];
  for (const t of ['cfg_sewing_line', 'cfg_checking_line', 'cfg_ironing_line', 'cfg_packing_line']) {
    await copy(t, lineCols, ['line_code'], { expr: { unit_id: unitMap('unit_id') } });
  }

  // ---------------------------------------------------------------- optional masters
  if (m.tax) {
    await copy('cfg_tax_rate',
      ['hsn_code', 'description', 'igst_pct', 'cgst_pct', 'sgst_pct', 'cess_pct', 'effective_from', 'effective_to', 'is_active'],
      ['hsn_code', 'effective_from']);
  }
  if (m.ledger) {
    await copy('mst_ledger_account', ['account_code', 'account_name', 'account_group', 'parent_id', 'is_bank', 'is_active'],
      ['account_code'], { expr: { parent_id: 'NULL' } });
    await txExecute(tx,
      `UPDATE mst_ledger_account n
         JOIN mst_ledger_account s  ON s.company_id = ${S} AND s.account_code = n.account_code AND s.parent_id IS NOT NULL
         JOIN mst_ledger_account sp ON sp.id = s.parent_id
         JOIN mst_ledger_account np ON np.company_id = ${N} AND np.account_code = sp.account_code
          SET n.parent_id = np.id
        WHERE n.company_id = ${N} AND n.parent_id IS NULL`);
  }
  if (m.colors) {
    await copy('mst_color', ['color_code', 'color_name', 'pantone_ref', 'hex_value', 'is_active'], ['color_code']);
  }
  if (m.sizeGroups) {
    // buyer_id points at the source company's party master — not carried over.
    await copy('mst_size_group', ['group_code', 'group_name', 'category', 'gender', 'buyer_id', 'description', 'is_active'],
      ['group_code'], { expr: { buyer_id: 'NULL' } });
    if (has('mst_size')) {
      await run('mst_size',
        `INSERT INTO mst_size (size_group_id, size_code, size_label, body_measurement, barcode_suffix, sort_order, is_active)
         SELECT ng.id, z.size_code, z.size_label, z.body_measurement, z.barcode_suffix, z.sort_order, z.is_active
           FROM mst_size z
           JOIN mst_size_group sg ON sg.id = z.size_group_id AND sg.company_id = ${S}
           JOIN mst_size_group ng ON ng.group_code = sg.group_code AND ng.company_id = ${N}
          WHERE NOT EXISTS (SELECT 1 FROM mst_size x WHERE x.size_group_id = ng.id AND x.size_code = z.size_code)`);
    }
  }
  if (m.gsm) await copy('mst_gsm', ['gsm_value', 'tolerance', 'is_active'], ['gsm_value']);
  if (m.dia) await copy('mst_dia', ['dia_value', 'uom', 'is_active'], ['dia_value']);
  if (m.yarnCounts) {
    await copy('mst_yarn_count',
      ['count_value', 'count_type', 'description', 'sort_order', 'is_active', 'created_by'],
      ['count_value', 'count_type'], { where: 's.is_deleted = 0', expr: { created_by: `${U}` } });
  }
  if (m.compositions) await copy('mst_composition', ['composition_code', 'description', 'is_active'], ['composition_code']);

  return out;
}
