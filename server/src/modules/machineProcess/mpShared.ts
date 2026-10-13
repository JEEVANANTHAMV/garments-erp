import type { Request } from 'express';
import { query, queryOne, txQueryOne, type Tx } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import type { Kind, RateRow } from './mpCalc.js';

/** Shared helpers of the embroidery / printing machine output & costing engine. */

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const LABEL: Record<Kind, string> = { EMBROIDERY: 'Embroidery', PRINTING: 'Printing' };
export const DOC: Record<Kind, { job: string; prod: string; mat: string; recipe: string }> = {
  EMBROIDERY: { job: 'EMB_JOB', prod: 'EMB_PROD', mat: 'EMB_MAT', recipe: 'EMB_RECIPE' },
  PRINTING: { job: 'PRT_JOB', prod: 'PRT_PROD', mat: 'PRT_MAT', recipe: 'PRT_RECIPE' },
};
export const MACHINE_TYPES: Record<Kind, [string, ...string[]]> = {
  EMBROIDERY: ['SINGLE_HEAD', 'MULTI_HEAD', 'COMPUTERIZED', 'MANUAL'],
  PRINTING: ['FLAT_BED', 'ROTARY', 'AUTOMATIC', 'MANUAL', 'DIGITAL'],
};
/** Process DC stages that feed each machine process (cfg_process_stage.stage_code). */
export const DC_STAGES: Record<Kind, string[]> = {
  EMBROIDERY: ['EMB', 'EMBROIDERY'],
  PRINTING: ['PRINT', 'PRINTING', 'PRT'],
};
export const ROLES: Record<Kind, [string, ...string[]]> = {
  EMBROIDERY: ['THREAD', 'BOBBIN', 'BACKING', 'TOPPING', 'ADHESIVE', 'OTHER'],
  PRINTING: ['DYE', 'PIGMENT', 'CHEMICAL', 'BINDER', 'INK', 'OTHER'],
};

export const has = (req: Request, ...codes: string[]) => !!req.user?.isSuperAdmin || codes.some((c) => req.user!.permissions.has(c));

export async function settingNum(cid: number, key: string, dflt: number) {
  const r = await queryOne<any>('SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?', [cid, key]);
  const v = Number(r?.v);
  return r && r.v !== null && r.v !== '' && Number.isFinite(v) ? v : dflt;
}

/** 'YYYY-MM-DDTHH:mm' / 'YYYY-MM-DD HH:mm[:ss]' → 'YYYY-MM-DD HH:mm:ss' (wall-clock, stored as typed). */
export function sqlDateTime(v: string) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v.trim());
  if (!m) throw BadRequest(`Invalid date-time "${v}" — use YYYY-MM-DDTHH:mm`);
  return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? '00'}`;
}
/** SQL expression giving a DATETIME back as the same wall-clock string the screen sent. */
export const dt = (col: string, alias: string) => `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i') AS ${alias}`;

export async function machineOf(cid: number, kind: Kind, id: number, tx?: Tx) {
  const sql = `SELECT * FROM mst_mp_machine WHERE id = ? AND company_id = ? AND process_kind = ?`;
  const m = tx ? await txQueryOne<any>(tx, sql, [id, cid, kind]) : await queryOne<any>(sql, [id, cid, kind]);
  if (!m) throw NotFound(`${LABEL[kind]} machine not found`);
  return m;
}

/** Rate in force on a date (effective-dated, so later rate changes never touch history). */
export async function rateOn(machineId: number, date: string, tx?: Tx): Promise<(RateRow & { id: number; effective_from: string }) | null> {
  const sql = `SELECT * FROM mst_mp_machine_rate WHERE machine_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`;
  const r = tx ? await txQueryOne<any>(tx, sql, [machineId, date]) : await queryOne<any>(sql, [machineId, date]);
  if (!r) return null;
  const out: any = { ...r };
  for (const k of ['machine_hour_rate', 'depreciation_rate_hour', 'electricity_rate_hour', 'maintenance_rate_hour', 'overhead_rate_hour', 'overhead_pct', 'operator_rate_hour', 'helper_rate_hour']) out[k] = n(r[k]);
  return out;
}

/**
 * Unit cost of a material on a job, per stock unit: weighted average of what the store issued
 * (net of returns) to the job, else the latest GRN rate of the lot, else the trims master rate.
 */
export async function jobUnitCost(jobId: number, trimId: number, tx?: Tx) {
  const sql = `SELECT COALESCE(SUM(CASE WHEN txn_type='ISSUE' THEN qty ELSE -qty END),0) q,
                      COALESCE(SUM(CASE WHEN txn_type='ISSUE' THEN amount ELSE -amount END),0) a
                 FROM trx_mp_material_txn WHERE job_id = ? AND trim_id = ? AND status = 'POSTED'`;
  const r = tx ? await txQueryOne<any>(tx, sql, [jobId, trimId]) : await queryOne<any>(sql, [jobId, trimId]);
  if (n(r?.q) > 0.00001 && n(r?.a) > 0) return n(r?.a) / n(r?.q);
  const t = tx ? await txQueryOne<any>(tx, `SELECT std_rate FROM mst_trim WHERE id = ?`, [trimId]) : await queryOne<any>(`SELECT std_rate FROM mst_trim WHERE id = ?`, [trimId]);
  return n(t?.std_rate);
}

/** Lot cost: latest GRN line rate of that lot, else the trims master rate. */
export async function lotUnitCost(tx: Tx, trimId: number, lotNo: string | null) {
  if (lotNo) {
    const g = await txQueryOne<any>(tx,
      `SELECT rate FROM trx_trim_grn_line WHERE trim_id = ? AND internal_lot_no = ? AND rate > 0 ORDER BY id DESC LIMIT 1`, [trimId, lotNo]);
    if (g) return n(g.rate);
  }
  const t = await txQueryOne<any>(tx, `SELECT std_rate FROM mst_trim WHERE id = ?`, [trimId]);
  return n(t?.std_rate);
}

/** Consumption-UOM units in one stock unit for a recipe line (same UOM → 1, else the UOM conversion master). */
export async function stockFactor(trimId: number, uomId: number, entered?: number | null) {
  const t = await queryOne<any>(`SELECT t.base_uom, u.code FROM mst_trim t LEFT JOIN cfg_uom u ON u.id = t.base_uom WHERE t.id = ?`, [trimId]);
  if (!t) throw BadRequest(`Material #${trimId} not found`);
  if (Number(t.base_uom) === Number(uomId)) return 1;
  if (entered && entered > 0) return entered;
  const c = await queryOne<any>(`SELECT factor FROM cfg_uom_conversion WHERE from_uom = ? AND to_uom = ?`, [t.base_uom, uomId]);
  if (c && n(c.factor) > 0) return n(c.factor);
  const back = await queryOne<any>(`SELECT factor FROM cfg_uom_conversion WHERE from_uom = ? AND to_uom = ?`, [uomId, t.base_uom]);
  if (back && n(back.factor) > 0) return 1 / n(back.factor);
  const u = await queryOne<any>(`SELECT code FROM cfg_uom WHERE id = ?`, [uomId]);
  throw BadRequest(`Give how many ${u?.code ?? 'units'} are in 1 ${t.code ?? 'stock unit'} for this material (e.g. 5000 MTR per CONE)`);
}

/** Stages a DC must be on to feed this process. */
export async function dcStageIds(cid: number, kind: Kind) {
  const rows = await query<any>(`SELECT id FROM cfg_process_stage WHERE company_id = ? AND UPPER(stage_code) IN (?)`, [cid, DC_STAGES[kind]]);
  return rows.map((r) => Number(r.id));
}
