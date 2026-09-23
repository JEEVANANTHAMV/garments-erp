import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

/**
 * Cutting → shipment fabric reports (Cutting to Shipment Fabric Traceability
 * document §22).
 *
 * Every report is read-only, company-scoped and parameterised. A report is a
 * function of (executor, company, filters) so the same code can be exercised
 * against a rolled-back test transaction. Each report returns column metadata
 * (label + UOM) alongside the rows so the UI never has to guess units.
 *
 * Fabric reconciliation formula (§16), applied identically everywhere:
 *   Unaccounted = Issued − Returned − Actual Consumption − Cutting Waste
 *                 − End Loss − Selvedge Loss − Remnant − Other Approved Loss
 *
 * Planned vs actual (§17): costing, BOM, marker and cutting actual KG/PC are
 * read from their own sources and reported side by side — nothing here
 * writes to, or overwrites, any of them.
 */
export const cuttingReportsRouter = Router();

// ─── types & helpers ────────────────────────────────────────────────────────

export type Run = (sql: string, params: unknown[]) => Promise<any[]>;

type ColType = 'text' | 'date' | 'datetime' | 'int' | 'kg' | 'kgpc' | 'pct' | 'days';

interface Col {
  key: string;
  label: string;
  type?: ColType;
  uom?: string;
  /** Include in the totals row as a plain sum. */
  sum?: boolean;
  /** Drill-down link kind the UI renders for this cell. */
  link?: 'bundle' | 'roll' | 'lot';
}

interface ReportResult {
  columns: Col[];
  rows: any[];
  /** Totals over ALL filtered rows (not just the current page). */
  totals?: Record<string, number | null>;
  notes?: string[];
}

interface ReportDef {
  key: string;
  title: string;
  run: (run: Run, cid: number, f: Filters) => Promise<ReportResult>;
}

/** Hard ceiling on rows a single report query returns before paging. */
const MAX_ROWS = 5000;

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const text = (max: number) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());
const isoDate = z.preprocess(blankToUndef,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD').optional());

const filterSchema = z.object({
  from_date: isoDate,
  to_date: isoDate,
  io_no: text(40),
  style: text(80),
  cut_order: text(40),
  fabric: text(150),
  lot_no: text(60),
  roll_no: text(60),
  status: z.preprocess(blankToUndef,
    z.string().trim().max(40).regex(/^[A-Za-z_]+$/, 'Status must be a status code').optional()),
  bundle: text(80),
  shipment: text(40),
  /** Unaccounted report: 1 = only rows breaching tolerance (default), 0 = all. */
  exceptions_only: z.preprocess(blankToUndef, z.enum(['0', '1']).optional()),
  page: z.preprocess(blankToUndef, z.coerce.number().int().min(1).max(100000).default(1)),
  page_size: z.preprocess(blankToUndef, z.coerce.number().int().min(1).max(1000).default(200)),
}).refine((f) => !f.from_date || !f.to_date || f.from_date <= f.to_date, {
  message: 'From date must be on or before To date', path: ['from_date'],
});

export type Filters = z.infer<typeof filterSchema>;

/** Escape LIKE wildcards so user text is matched literally. */
const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Small WHERE builder: fragments joined with AND, params in order. */
class Where {
  parts: string[] = [];
  params: unknown[] = [];
  add(sql: string, ...p: unknown[]) { this.parts.push(sql); this.params.push(...p); return this; }
  get sql() { return this.parts.length ? ` AND ${this.parts.join(' AND ')}` : ''; }
}

const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
const round = (v: number | null, dp: number) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;
const ratio = (num: number | null, den: number | null, dp = 4) =>
  num == null || !den ? null : round(num / den, dp);
const pct = (num: number | null, den: number | null) =>
  num == null || !den ? null : round((num / den) * 100, 2);

/** Coerce DECIMAL strings etc. to numbers per column type, rounding for display. */
function normalise(rows: any[], cols: Col[]) {
  for (const r of rows) {
    for (const c of cols) {
      const v = r[c.key];
      if (v == null) continue;
      switch (c.type) {
        case 'int': case 'days': r[c.key] = Number(v); break;
        case 'kg': r[c.key] = round(Number(v), 3); break;
        case 'kgpc': r[c.key] = round(Number(v), 4); break;
        case 'pct': r[c.key] = round(Number(v), 2); break;
        default: break;
      }
    }
  }
  return rows;
}

function sumTotals(rows: any[], cols: Col[]) {
  const t: Record<string, number | null> = {};
  for (const c of cols) {
    if (!c.sum) continue;
    const s = rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0);
    t[c.key] = c.type === 'int' ? s : round(s, 3);
  }
  return t;
}

async function tolerancePct(run: Run, cid: number): Promise<number> {
  const rows = await run(
    `SELECT setting_value FROM cfg_system_setting
      WHERE company_id = ? AND setting_key = 'CUTTING_RECON_TOLERANCE_PCT' LIMIT 1`, [cid]);
  const v = Number(rows[0]?.setting_value);
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
}

// ─── shared filter fragments ────────────────────────────────────────────────

/** Style text filter against an mst_style alias. */
function styleFilter(w: Where, f: Filters, st = 'st') {
  if (f.style) w.add(`(${st}.style_code LIKE ? OR ${st}.style_name LIKE ?)`, like(f.style), like(f.style));
}
function fabricFilter(w: Where, f: Filters, fb = 'fb') {
  if (f.fabric) w.add(`(${fb}.fabric_code LIKE ? OR ${fb}.fabric_name LIKE ?)`, like(f.fabric), like(f.fabric));
}
function dateFilter(w: Where, f: Filters, col: string) {
  if (f.from_date) w.add(`${col} >= ?`, f.from_date);
  if (f.to_date) w.add(`${col} < DATE_ADD(?, INTERVAL 1 DAY)`, f.to_date);
}

/** Lot / roll filter for anything keyed by a cut order (DC rolls or lay rolls). */
function planLotRollFilter(w: Where, f: Filters, planId: string) {
  for (const [val, col] of [[f.lot_no, 'lot_no'], [f.roll_no, 'roll_no']] as const) {
    if (!val) continue;
    w.add(`(EXISTS (SELECT 1 FROM trx_fabric_issue fi_x
                      JOIN trx_fabric_issue_roll fir_x ON fir_x.fabric_issue_id = fi_x.id
                     WHERE fi_x.cutting_plan_id = ${planId} AND fir_x.${col} LIKE ?)
            OR EXISTS (SELECT 1 FROM trx_lay_plan lp_x
                         JOIN trx_lay_roll lr_x ON lr_x.lay_id = lp_x.id
                        WHERE lp_x.cutting_plan_id = ${planId} AND lr_x.${col} LIKE ?))`,
      like(val), like(val));
  }
}

/** Lot / roll filter for anything keyed by a lay. */
function layLotRollFilter(w: Where, f: Filters, layId: string) {
  if (f.lot_no) w.add(`EXISTS (SELECT 1 FROM trx_lay_roll lr_x WHERE lr_x.lay_id = ${layId} AND lr_x.lot_no LIKE ?)`, like(f.lot_no));
  if (f.roll_no) w.add(`EXISTS (SELECT 1 FROM trx_lay_roll lr_x WHERE lr_x.lay_id = ${layId} AND lr_x.roll_no LIKE ?)`, like(f.roll_no));
}

/** Standard cut-order filters (cp / st / fb aliases). */
function planFilters(w: Where, f: Filters, opts: { date?: string; status?: string } = {}) {
  dateFilter(w, f, opts.date ?? 'cp.plan_date');
  if (f.io_no) w.add('cp.io_no LIKE ?', like(f.io_no));
  if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
  styleFilter(w, f);
  fabricFilter(w, f);
  if (f.status) w.add(`${opts.status ?? 'cp.status'} = ?`, f.status.toUpperCase());
  planLotRollFilter(w, f, 'cp.id');
}

// ─── cut-order fabric balance (reports 1, 7, 8, 13) ─────────────────────────

/**
 * One row per cut order with issued / returned / consumed / losses.
 *
 * Issued counts every non-draft DC roll line. Consumption is the lay's
 * recorded actual KG, falling back to the sum of its roll lines (before −
 * after) when the header was not rolled up. Losses exclude reversed entries.
 */
async function planBalance(run: Run, cid: number, f: Filters) {
  const w = new Where();
  planFilters(w, f);
  const rows = await run(
    `SELECT cp.id AS cutting_plan_id, cp.plan_no, cp.plan_date, cp.io_no, cp.status,
            cp.style_id, cp.so_id, cp.fabric_id,
            st.style_code, st.style_name, clr.color_name, fb.fabric_code, fb.fabric_name,
            cp.order_qty, cp.planned_cut_qty,
            COALESCE(iss.issued_kg, 0)   AS issued_kg,
            COALESCE(iss.returned_kg, 0) AS returned_kg,
            COALESCE(iss.dc_count, 0)    AS dc_count,
            COALESCE(iss.roll_count, 0)  AS roll_count,
            COALESCE(lay.consumed_kg, 0) AS consumed_kg,
            COALESCE(lay.cut_qty, 0)     AS actual_cut_qty,
            COALESCE(lay.lay_count, 0)   AS lay_count,
            lay.marker_kg_per_pc,
            COALESCE(ls.waste_kg, 0)     AS cutting_waste_kg,
            COALESCE(ls.end_loss_kg, 0)  AS end_loss_kg,
            COALESCE(ls.selvedge_kg, 0)  AS selvedge_kg,
            COALESCE(ls.remnant_kg, 0)   AS remnant_kg,
            COALESCE(ls.other_kg, 0)     AS other_loss_kg,
            rec.recon_no, rec.status AS recon_status, rec.unaccounted_kg AS recon_unaccounted_kg
       FROM trx_cutting_plan cp
       LEFT JOIN mst_style  st  ON st.id  = cp.style_id
       LEFT JOIN mst_color  clr ON clr.id = cp.color_id
       LEFT JOIN mst_fabric fb  ON fb.id  = cp.fabric_id
       LEFT JOIN (
         SELECT fi.cutting_plan_id,
                SUM(fir.issue_kg) AS issued_kg, SUM(fir.returned_kg) AS returned_kg,
                COUNT(DISTINCT fi.id) AS dc_count, COUNT(fir.id) AS roll_count
           FROM trx_fabric_issue fi
           JOIN trx_fabric_issue_roll fir ON fir.fabric_issue_id = fi.id
          WHERE fi.company_id = ? AND fi.status <> 'DRAFT' AND fi.cutting_plan_id IS NOT NULL
          GROUP BY fi.cutting_plan_id
       ) iss ON iss.cutting_plan_id = cp.id
       LEFT JOIN (
         SELECT lp.cutting_plan_id,
                SUM(COALESCE(NULLIF(lp.actual_kg, 0), lr.kg, 0)) AS consumed_kg,
                SUM(COALESCE(NULLIF(lp.actual_cut_qty, 0), co.good, 0)) AS cut_qty,
                COUNT(*) AS lay_count,
                SUM(mv.cad_kg_per_pc * GREATEST(lp.expected_pieces, lp.actual_cut_qty))
                  / NULLIF(SUM(CASE WHEN mv.cad_kg_per_pc IS NOT NULL
                                    THEN GREATEST(lp.expected_pieces, lp.actual_cut_qty) END), 0)
                  AS marker_kg_per_pc
           FROM trx_lay_plan lp
           LEFT JOIN (SELECT lay_id, SUM(actual_consumed_kg) AS kg FROM trx_lay_roll
                       WHERE company_id = ? GROUP BY lay_id) lr ON lr.lay_id = lp.id
           LEFT JOIN (SELECT lay_id, SUM(good_qty) AS good FROM trx_cut_output
                       WHERE company_id = ? AND status <> 'REVERSED' GROUP BY lay_id) co ON co.lay_id = lp.id
           LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
          WHERE lp.company_id = ? AND lp.status <> 'CANCELLED' AND lp.cutting_plan_id IS NOT NULL
          GROUP BY lp.cutting_plan_id
       ) lay ON lay.cutting_plan_id = cp.id
       LEFT JOIN (
         SELECT cutting_plan_id,
                SUM(CASE WHEN loss_type = 'CUTTING_WASTE' THEN qty_kg ELSE 0 END) AS waste_kg,
                SUM(CASE WHEN loss_type = 'END_LOSS'      THEN qty_kg ELSE 0 END) AS end_loss_kg,
                SUM(CASE WHEN loss_type = 'SELVEDGE_LOSS' THEN qty_kg ELSE 0 END) AS selvedge_kg,
                SUM(CASE WHEN loss_type = 'REMNANT'       THEN qty_kg ELSE 0 END) AS remnant_kg,
                SUM(CASE WHEN loss_type = 'OTHER'         THEN qty_kg ELSE 0 END) AS other_kg
           FROM trx_cutting_loss
          WHERE company_id = ? AND is_reversed = 0
          GROUP BY cutting_plan_id
       ) ls ON ls.cutting_plan_id = cp.id
       LEFT JOIN (
         SELECT r.cutting_plan_id, r.recon_no, r.status, r.unaccounted_kg
           FROM trx_cutting_reconciliation r
           JOIN (SELECT cutting_plan_id, MAX(id) AS id FROM trx_cutting_reconciliation
                  WHERE company_id = ? GROUP BY cutting_plan_id) m ON m.id = r.id
       ) rec ON rec.cutting_plan_id = cp.id
      WHERE cp.company_id = ?${w.sql}
      ORDER BY cp.plan_date DESC, cp.id DESC
      LIMIT ${MAX_ROWS + 1}`,
    [cid, cid, cid, cid, cid, cid, cid, ...w.params]);

  for (const r of rows) {
    const issued = Number(r.issued_kg), returned = Number(r.returned_kg);
    const consumed = Number(r.consumed_kg);
    const losses = Number(r.cutting_waste_kg) + Number(r.end_loss_kg) + Number(r.selvedge_kg)
      + Number(r.remnant_kg) + Number(r.other_loss_kg);
    r.net_issued_kg = round(issued - returned, 4);
    r.total_loss_kg = round(losses, 4);
    r.unaccounted_kg = round(issued - returned - consumed - losses, 4);
    r.unaccounted_pct = pct(r.unaccounted_kg, issued);
    r.actual_kg_per_pc = ratio(consumed, Number(r.actual_cut_qty));
  }
  return rows;
}

const PLAN_ID_COLS: Col[] = [
  { key: 'plan_no', label: 'Cut Order' },
  { key: 'plan_date', label: 'Date', type: 'date' },
  { key: 'io_no', label: 'IO No' },
  { key: 'style_code', label: 'Style' },
  { key: 'color_name', label: 'Color' },
  { key: 'fabric_name', label: 'Fabric' },
];

// ─── report definitions ─────────────────────────────────────────────────────

const REPORTS: ReportDef[] = [
  // 1 ─────────────────────────────────────────────────────────────────────
  {
    key: 'fabric-dc-vs-consumption',
    title: 'Fabric DC vs Actual Cutting Consumption',
    async run(run, cid, f) {
      const rows = await planBalance(run, cid, f);
      const columns: Col[] = [
        ...PLAN_ID_COLS,
        { key: 'status', label: 'Status' },
        { key: 'dc_count', label: 'DCs', type: 'int', sum: true },
        { key: 'issued_kg', label: 'Issued', type: 'kg', uom: 'KG', sum: true },
        { key: 'returned_kg', label: 'Returned', type: 'kg', uom: 'KG', sum: true },
        { key: 'consumed_kg', label: 'Actual Consumption', type: 'kg', uom: 'KG', sum: true },
        { key: 'cutting_waste_kg', label: 'Cutting Waste', type: 'kg', uom: 'KG', sum: true },
        { key: 'end_loss_kg', label: 'End Loss', type: 'kg', uom: 'KG', sum: true },
        { key: 'selvedge_kg', label: 'Selvedge Loss', type: 'kg', uom: 'KG', sum: true },
        { key: 'remnant_kg', label: 'Remnant', type: 'kg', uom: 'KG', sum: true },
        { key: 'other_loss_kg', label: 'Other Loss', type: 'kg', uom: 'KG', sum: true },
        { key: 'unaccounted_kg', label: 'Unaccounted', type: 'kg', uom: 'KG', sum: true },
        { key: 'unaccounted_pct', label: 'Unaccounted', type: 'pct', uom: '% of issued' },
        { key: 'recon_status', label: 'Recon Status' },
      ];
      return { columns, rows,
        notes: ['Unaccounted = Issued − Returned − Consumption − Waste − End Loss − Selvedge − Remnant − Other.'] };
    },
  },

  // 2 ─────────────────────────────────────────────────────────────────────
  {
    key: 'roll-utilization',
    title: 'Roll-wise Fabric Utilization',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'fi.issue_date');
      if (f.io_no) w.add('COALESCE(cp.io_no, fi.io_no) LIKE ?', like(f.io_no));
      if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.lot_no) w.add('COALESCE(fr.lot_no, fir.lot_no) LIKE ?', like(f.lot_no));
      if (f.roll_no) w.add('COALESCE(fr.roll_no, fir.roll_no) LIKE ?', like(f.roll_no));
      if (f.status) w.add('fir.roll_status = ?', f.status.toUpperCase());
      const rows = await run(
        `SELECT fir.fabric_roll_id,
                COALESCE(fr.roll_no, fir.roll_no) AS roll_no,
                COALESCE(fr.lot_no, fir.lot_no)   AS lot_no,
                MAX(fb.fabric_name) AS fabric_name,
                MAX(COALESCE(fr.shade, fir.shade)) AS shade,
                MAX(fr.weight_kg)  AS received_kg,
                SUM(fir.issue_kg)  AS issued_kg,
                SUM(COALESCE(lr.kg, fir.consumed_kg)) AS consumed_kg,
                SUM(fir.returned_kg) AS returned_kg,
                MAX(lr.lays) AS lay_count,
                GROUP_CONCAT(DISTINCT fi.issue_no ORDER BY fi.issue_no SEPARATOR ', ') AS dc_nos,
                GROUP_CONCAT(DISTINCT cp.plan_no ORDER BY cp.plan_no SEPARATOR ', ') AS cut_orders,
                GROUP_CONCAT(DISTINCT cp.io_no SEPARATOR ', ') AS io_nos,
                MAX(fir.roll_status) AS roll_status,
                MAX(fr.stock_status) AS stock_status
           FROM trx_fabric_issue_roll fir
           JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
           LEFT JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id AND fr.company_id = fi.company_id
           LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id
           LEFT JOIN mst_style st ON st.id = COALESCE(cp.style_id, fi.style_id)
           LEFT JOIN mst_fabric fb ON fb.id = COALESCE(fr.fabric_id, fi.fabric_id)
           LEFT JOIN (
             SELECT lr0.fabric_issue_roll_id, SUM(lr0.actual_consumed_kg) AS kg, COUNT(DISTINCT lr0.lay_id) AS lays
               FROM trx_lay_roll lr0 JOIN trx_lay_plan lp0 ON lp0.id = lr0.lay_id
              WHERE lr0.company_id = ? AND lp0.status <> 'CANCELLED' AND lr0.fabric_issue_roll_id IS NOT NULL
              GROUP BY lr0.fabric_issue_roll_id
           ) lr ON lr.fabric_issue_roll_id = fir.id
          WHERE fi.company_id = ? AND fi.status <> 'DRAFT'${w.sql}
          GROUP BY fir.fabric_roll_id, COALESCE(fr.roll_no, fir.roll_no), COALESCE(fr.lot_no, fir.lot_no)
          ORDER BY lot_no, roll_no
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, ...w.params]);
      for (const r of rows) {
        const issued = Number(r.issued_kg), returned = Number(r.returned_kg), consumed = Number(r.consumed_kg);
        r.on_floor_kg = round(issued - returned - consumed, 4);
        r.utilisation_pct = pct(consumed, issued - returned);
      }
      const columns: Col[] = [
        { key: 'roll_no', label: 'Roll No', link: 'roll' },
        { key: 'lot_no', label: 'Lot No', link: 'lot' },
        { key: 'fabric_name', label: 'Fabric' },
        { key: 'shade', label: 'Shade' },
        { key: 'io_nos', label: 'IO No' },
        { key: 'cut_orders', label: 'Cut Orders' },
        { key: 'dc_nos', label: 'DC Nos' },
        { key: 'received_kg', label: 'Received', type: 'kg', uom: 'KG', sum: true },
        { key: 'issued_kg', label: 'Issued', type: 'kg', uom: 'KG', sum: true },
        { key: 'consumed_kg', label: 'Consumed in Lays', type: 'kg', uom: 'KG', sum: true },
        { key: 'returned_kg', label: 'Returned / Remnant', type: 'kg', uom: 'KG', sum: true },
        { key: 'on_floor_kg', label: 'Balance on Floor', type: 'kg', uom: 'KG', sum: true },
        { key: 'lay_count', label: 'Lays', type: 'int' },
        { key: 'utilisation_pct', label: 'Utilisation', type: 'pct', uom: '%' },
        { key: 'roll_status', label: 'Roll Status' },
      ];
      const totals = (all: any[]) => {
        const t = sumTotals(all, columns);
        t.utilisation_pct = pct(t.consumed_kg ?? 0, (t.issued_kg ?? 0) - (t.returned_kg ?? 0));
        return t;
      };
      return { columns, rows, totals: totals(rows),
        notes: ['Utilisation = Consumed ÷ (Issued − Returned) × 100.'] };
    },
  },

  // 3 ─────────────────────────────────────────────────────────────────────
  {
    key: 'cut-order-status',
    title: 'Cut Order Status',
    async run(run, cid, f) {
      const w = new Where();
      planFilters(w, f);
      const rows = await run(
        `SELECT cp.plan_no, cp.plan_date, cp.required_date, cp.io_no, st.style_code, clr.color_name,
                fb.fabric_name, cp.order_qty, cp.planned_cut_qty, cp.over_cut_pct,
                CASE WHEN co.n > 0 THEN co.good ELSE cp.actual_cut_qty END AS actual_cut_qty,
                COALESCE(co.reject, 0) AS reject_qty, COALESCE(co.recut, 0) AS recut_qty,
                COALESCE(lay.total, 0) AS lay_count, COALESCE(lay.done, 0) AS lays_cut,
                COALESCE(bd.n, 0) AS bundle_count,
                cp.status
           FROM trx_cutting_plan cp
           LEFT JOIN mst_style  st  ON st.id  = cp.style_id
           LEFT JOIN mst_color  clr ON clr.id = cp.color_id
           LEFT JOIN mst_fabric fb  ON fb.id  = cp.fabric_id
           LEFT JOIN (SELECT cutting_plan_id, COUNT(*) AS n, SUM(good_qty) AS good,
                             SUM(reject_qty) AS reject, SUM(recut_qty) AS recut
                        FROM trx_cut_output WHERE company_id = ? AND status <> 'REVERSED'
                       GROUP BY cutting_plan_id) co ON co.cutting_plan_id = cp.id
           LEFT JOIN (SELECT cutting_plan_id, COUNT(*) AS total,
                             SUM(status IN ('CUT','APPROVED')) AS done
                        FROM trx_lay_plan WHERE company_id = ? AND status <> 'CANCELLED'
                       GROUP BY cutting_plan_id) lay ON lay.cutting_plan_id = cp.id
           LEFT JOIN (SELECT lp.cutting_plan_id, COUNT(*) AS n
                        FROM trx_cutting_bundle b JOIN trx_lay_plan lp ON lp.id = b.lay_id
                       WHERE b.company_id = ? AND b.status <> 'CANCELLED' AND b.parent_bundle_id IS NULL
                       GROUP BY lp.cutting_plan_id) bd ON bd.cutting_plan_id = cp.id
          WHERE cp.company_id = ?${w.sql}
          ORDER BY cp.plan_date DESC, cp.id DESC
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, cid, cid, ...w.params]);
      for (const r of rows) {
        const planned = Number(r.planned_cut_qty) || 0, actual = Number(r.actual_cut_qty) || 0;
        r.balance_qty = planned - actual;
        r.complete_pct = pct(actual, planned);
      }
      const columns: Col[] = [
        { key: 'plan_no', label: 'Cut Order' },
        { key: 'plan_date', label: 'Date', type: 'date' },
        { key: 'required_date', label: 'Required', type: 'date' },
        { key: 'io_no', label: 'IO No' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'order_qty', label: 'Order Qty', type: 'int', uom: 'PCS', sum: true },
        { key: 'planned_cut_qty', label: 'Planned Cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'actual_cut_qty', label: 'Actual Cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'balance_qty', label: 'Balance', type: 'int', uom: 'PCS', sum: true },
        { key: 'reject_qty', label: 'Reject', type: 'int', uom: 'PCS', sum: true },
        { key: 'recut_qty', label: 'Re-cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'lay_count', label: 'Lays', type: 'int', sum: true },
        { key: 'lays_cut', label: 'Lays Cut', type: 'int', sum: true },
        { key: 'bundle_count', label: 'Bundles', type: 'int', sum: true },
        { key: 'complete_pct', label: 'Complete', type: 'pct', uom: '%' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      totals.complete_pct = pct(totals.actual_cut_qty ?? 0, totals.planned_cut_qty ?? 0);
      return { columns, rows, totals };
    },
  },

  // 4 ─────────────────────────────────────────────────────────────────────
  {
    key: 'marker-consumption',
    title: 'Marker Consumption',
    async run(run, cid, f) {
      // Lay-side filters narrow which lays count; the date filter is the lay date.
      const lw = new Where();
      dateFilter(lw, f, 'lp.lay_date');
      if (f.io_no) lw.add('lp.io_no LIKE ?', like(f.io_no));
      if (f.cut_order) lw.add('cp.plan_no LIKE ?', like(f.cut_order));
      layLotRollFilter(lw, f, 'lp.id');
      const layFiltered = lw.parts.length > 0;
      const w = new Where();
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.status) w.add(f.status.toUpperCase() === 'LOCKED' ? 'mv.is_locked = 1' : 'mv.is_locked = 0');
      const rows = await run(
        `SELECT mv.marker_no, mv.version, mv.marker_name, st.style_code, clr.color_name,
                COALESCE(fb.fabric_name, mv.fabric_type) AS fabric_name,
                mv.width_in, mv.length_m, mv.pieces_per_marker, mv.marker_kg_per_ply, mv.cad_kg_per_pc,
                COALESCE(l.lays, 0) AS lays_used, COALESCE(l.plies, 0) AS plies,
                COALESCE(l.pcs, 0) AS pieces_cut, COALESCE(l.kg, 0) AS actual_kg,
                IF(mv.is_locked = 1, 'LOCKED', 'OPEN') AS status
           FROM trx_marker_version mv
           LEFT JOIN mst_style st ON st.id = mv.style_id
           LEFT JOIN mst_color clr ON clr.id = mv.color_id
           LEFT JOIN mst_fabric fb ON fb.id = mv.fabric_id
           ${layFiltered ? 'JOIN' : 'LEFT JOIN'} (
             SELECT lp.marker_version_id, COUNT(*) AS lays, SUM(lp.ply_count) AS plies,
                    SUM(COALESCE(NULLIF(lp.actual_cut_qty, 0), co.good, 0)) AS pcs,
                    SUM(COALESCE(NULLIF(lp.actual_kg, 0), lr.kg, 0)) AS kg
               FROM trx_lay_plan lp
               LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
               LEFT JOIN (SELECT lay_id, SUM(actual_consumed_kg) AS kg FROM trx_lay_roll
                           WHERE company_id = ? GROUP BY lay_id) lr ON lr.lay_id = lp.id
               LEFT JOIN (SELECT lay_id, SUM(good_qty) AS good FROM trx_cut_output
                           WHERE company_id = ? AND status <> 'REVERSED' GROUP BY lay_id) co ON co.lay_id = lp.id
              WHERE lp.company_id = ? AND lp.status <> 'CANCELLED' AND lp.marker_version_id IS NOT NULL${lw.sql}
              GROUP BY lp.marker_version_id
           ) l ON l.marker_version_id = mv.id
          WHERE mv.company_id = ?${w.sql}
          ORDER BY mv.marker_no, mv.version DESC
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, cid, ...lw.params, cid, ...w.params]);
      for (const r of rows) {
        r.actual_kg_per_pc = ratio(Number(r.actual_kg), Number(r.pieces_cut));
        const cad = n(r.cad_kg_per_pc);
        r.variance_kg_per_pc = r.actual_kg_per_pc == null || cad == null ? null : round(r.actual_kg_per_pc - cad, 4);
        r.variance_pct = r.variance_kg_per_pc == null ? null : pct(r.variance_kg_per_pc, cad);
      }
      const columns: Col[] = [
        { key: 'marker_no', label: 'Marker' },
        { key: 'version', label: 'Ver', type: 'int' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'fabric_name', label: 'Fabric' },
        { key: 'width_in', label: 'Width', type: 'kg', uom: 'IN' },
        { key: 'length_m', label: 'Length', type: 'kg', uom: 'MTR' },
        { key: 'pieces_per_marker', label: 'Pieces / Marker', type: 'int', uom: 'PCS' },
        { key: 'cad_kg_per_pc', label: 'CAD', type: 'kgpc', uom: 'KG/PC' },
        { key: 'lays_used', label: 'Lays Used', type: 'int', sum: true },
        { key: 'plies', label: 'Plies', type: 'int', sum: true },
        { key: 'pieces_cut', label: 'Pieces Cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'actual_kg', label: 'Actual', type: 'kg', uom: 'KG', sum: true },
        { key: 'actual_kg_per_pc', label: 'Actual', type: 'kgpc', uom: 'KG/PC' },
        { key: 'variance_kg_per_pc', label: 'Variance', type: 'kgpc', uom: 'KG/PC' },
        { key: 'variance_pct', label: 'Variance', type: 'pct', uom: '%' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      totals.actual_kg_per_pc = ratio(totals.actual_kg ?? 0, totals.pieces_cut ?? 0);
      return { columns, rows, totals, notes: ['Variance = Actual KG/PC − CAD KG/PC; % of CAD.'] };
    },
  },

  // 5 ─────────────────────────────────────────────────────────────────────
  {
    key: 'lay-consumption',
    title: 'Lay-wise Consumption',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'lp.lay_date');
      if (f.io_no) w.add('COALESCE(lp.io_no, cp.io_no) LIKE ?', like(f.io_no));
      if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.status) w.add('lp.status = ?', f.status.toUpperCase());
      else w.add(`lp.status <> 'CANCELLED'`);
      layLotRollFilter(w, f, 'lp.id');
      const rows = await run(
        `SELECT lp.lay_no, lp.lay_date, cp.plan_no, COALESCE(lp.io_no, cp.io_no) AS io_no,
                st.style_code, clr.color_name, fb.fabric_name,
                CONCAT(mv.marker_no, ' v', mv.version) AS marker, mv.cad_kg_per_pc,
                lp.ply_count, lp.expected_pieces, lp.planned_kg,
                COALESCE(lr.rolls, 0) AS roll_count, lr.roll_nos, lr.lot_nos,
                COALESCE(lr.before_kg, 0) AS before_kg, COALESCE(lr.after_kg, 0) AS after_kg,
                COALESCE(NULLIF(lp.actual_kg, 0), lr.kg, 0) AS consumed_kg,
                COALESCE(NULLIF(lp.actual_cut_qty, 0), co.good, 0) AS actual_cut_qty,
                lp.status
           FROM trx_lay_plan lp
           LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
           LEFT JOIN mst_style st ON st.id = COALESCE(lp.style_id, cp.style_id)
           LEFT JOIN mst_color clr ON clr.id = COALESCE(lp.color_id, cp.color_id)
           LEFT JOIN mst_fabric fb ON fb.id = COALESCE(lp.fabric_id, cp.fabric_id)
           LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
           LEFT JOIN (SELECT lay_id, COUNT(*) AS rolls, SUM(before_kg) AS before_kg, SUM(after_kg) AS after_kg,
                             SUM(actual_consumed_kg) AS kg,
                             GROUP_CONCAT(DISTINCT roll_no ORDER BY roll_no SEPARATOR ', ') AS roll_nos,
                             GROUP_CONCAT(DISTINCT lot_no ORDER BY lot_no SEPARATOR ', ') AS lot_nos
                        FROM trx_lay_roll WHERE company_id = ? GROUP BY lay_id) lr ON lr.lay_id = lp.id
           LEFT JOIN (SELECT lay_id, SUM(good_qty) AS good FROM trx_cut_output
                       WHERE company_id = ? AND status <> 'REVERSED' GROUP BY lay_id) co ON co.lay_id = lp.id
          WHERE lp.company_id = ?${w.sql}
          ORDER BY lp.lay_date DESC, lp.id DESC
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, cid, ...w.params]);
      for (const r of rows) {
        const kg = Number(r.consumed_kg), pcs = Number(r.actual_cut_qty), planned = n(r.planned_kg);
        r.actual_kg_per_pc = ratio(kg, pcs);
        r.planned_kg_per_pc = ratio(planned, Number(r.expected_pieces));
        r.variance_kg = planned == null || !kg ? null : round(kg - planned, 4);
        r.variance_pct = r.variance_kg == null ? null : pct(r.variance_kg, planned);
      }
      const columns: Col[] = [
        { key: 'lay_no', label: 'Lay No' },
        { key: 'lay_date', label: 'Date', type: 'date' },
        { key: 'plan_no', label: 'Cut Order' },
        { key: 'io_no', label: 'IO No' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'marker', label: 'Marker' },
        { key: 'roll_nos', label: 'Rolls', link: 'roll' },
        { key: 'lot_nos', label: 'Lots' },
        { key: 'roll_count', label: 'Rolls', type: 'int', sum: true },
        { key: 'ply_count', label: 'Plies', type: 'int', sum: true },
        { key: 'before_kg', label: 'Before', type: 'kg', uom: 'KG', sum: true },
        { key: 'after_kg', label: 'After', type: 'kg', uom: 'KG', sum: true },
        { key: 'consumed_kg', label: 'Consumed', type: 'kg', uom: 'KG', sum: true },
        { key: 'expected_pieces', label: 'Expected', type: 'int', uom: 'PCS', sum: true },
        { key: 'actual_cut_qty', label: 'Cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'planned_kg', label: 'Planned', type: 'kg', uom: 'KG', sum: true },
        { key: 'planned_kg_per_pc', label: 'Planned', type: 'kgpc', uom: 'KG/PC' },
        { key: 'actual_kg_per_pc', label: 'Actual', type: 'kgpc', uom: 'KG/PC' },
        { key: 'variance_kg', label: 'Variance', type: 'kg', uom: 'KG', sum: true },
        { key: 'variance_pct', label: 'Variance', type: 'pct', uom: '%' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      totals.actual_kg_per_pc = ratio(totals.consumed_kg ?? 0, totals.actual_cut_qty ?? 0);
      totals.planned_kg_per_pc = ratio(totals.planned_kg ?? 0, totals.expected_pieces ?? 0);
      return { columns, rows, totals };
    },
  },

  // 6 ─────────────────────────────────────────────────────────────────────
  {
    key: 'style-color-size-consumption',
    title: 'Style / Color / Size Consumption',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'co.created_at');
      if (f.io_no) w.add('COALESCE(co.io_no, cp.io_no) LIKE ?', like(f.io_no));
      if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.status) w.add('co.status = ?', f.status.toUpperCase());
      else w.add(`co.status <> 'REVERSED'`);
      layLotRollFilter(w, f, 'co.lay_id');
      const rows = await run(
        `SELECT st.style_code, st.style_name, clr.color_name, sz.size_code, MIN(sz.sort_order) AS size_sort,
                st.id AS style_id, co.size_id,
                SUM(co.good_qty) AS good_qty, SUM(co.reject_qty) AS reject_qty, SUM(co.recut_qty) AS recut_qty,
                SUM(co.actual_kg) AS actual_kg, COUNT(DISTINCT co.lay_id) AS lay_count
           FROM trx_cut_output co
           LEFT JOIN trx_cutting_plan cp ON cp.id = co.cutting_plan_id
           LEFT JOIN mst_style st ON st.id = COALESCE(co.style_id, cp.style_id)
           LEFT JOIN mst_color clr ON clr.id = COALESCE(co.color_id, cp.color_id)
           LEFT JOIN mst_size sz ON sz.id = co.size_id
           LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
          WHERE co.company_id = ?${w.sql}
          GROUP BY st.id, clr.id, co.size_id, sz.id
          ORDER BY st.style_code, clr.color_name, size_sort, sz.size_code
          LIMIT ${MAX_ROWS + 1}`, [cid, ...w.params]);
      // Approved/costing size consumption (latest active version) as a reference.
      const styleIds = [...new Set(rows.map((r) => r.style_id).filter(Boolean))];
      const ref = new Map<string, { kg: number; source: string }>();
      if (styleIds.length) {
        const sc = await run(
          `SELECT style_id, size_id, kg_per_pc, source, version, effective_from
             FROM trx_size_consumption
            WHERE company_id = ? AND is_active = 1 AND style_id IN (?) AND effective_from <= CURDATE()
            ORDER BY FIELD(source, 'APPROVED', 'ACTUAL', 'MARKER', 'COSTING'), effective_from DESC, version DESC`,
          [cid, styleIds]);
        for (const s of sc) {
          const k = `${s.style_id}:${s.size_id}`;
          if (!ref.has(k)) ref.set(k, { kg: Number(s.kg_per_pc), source: s.source });
        }
      }
      for (const r of rows) {
        r.actual_kg_per_pc = ratio(Number(r.actual_kg), Number(r.good_qty));
        const s = ref.get(`${r.style_id}:${r.size_id}`);
        r.std_kg_per_pc = s ? round(s.kg, 4) : null;
        r.std_source = s?.source ?? null;
        r.variance_kg_per_pc = s && r.actual_kg_per_pc != null ? round(r.actual_kg_per_pc - s.kg, 4) : null;
        r.variance_pct = r.variance_kg_per_pc == null ? null : pct(r.variance_kg_per_pc, s!.kg);
        delete r.style_id; delete r.size_id; delete r.size_sort;
      }
      const columns: Col[] = [
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'size_code', label: 'Size' },
        { key: 'lay_count', label: 'Lays', type: 'int' },
        { key: 'good_qty', label: 'Good', type: 'int', uom: 'PCS', sum: true },
        { key: 'reject_qty', label: 'Reject', type: 'int', uom: 'PCS', sum: true },
        { key: 'recut_qty', label: 'Re-cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'actual_kg', label: 'Actual', type: 'kg', uom: 'KG', sum: true },
        { key: 'actual_kg_per_pc', label: 'Actual', type: 'kgpc', uom: 'KG/PC' },
        { key: 'std_kg_per_pc', label: 'Standard', type: 'kgpc', uom: 'KG/PC' },
        { key: 'std_source', label: 'Std Source' },
        { key: 'variance_kg_per_pc', label: 'Variance', type: 'kgpc', uom: 'KG/PC' },
        { key: 'variance_pct', label: 'Variance', type: 'pct', uom: '%' },
      ];
      const totals = sumTotals(rows, columns);
      totals.actual_kg_per_pc = ratio(totals.actual_kg ?? 0, totals.good_qty ?? 0);
      return { columns, rows, totals };
    },
  },

  // 7 ─────────────────────────────────────────────────────────────────────
  {
    key: 'planned-vs-actual',
    title: 'Planned vs Actual Consumption Variance',
    async run(run, cid, f) {
      const rows = await planBalance(run, cid, f);
      const styleIds = [...new Set(rows.map((r) => r.style_id).filter(Boolean))];

      // Costing: latest version per style that carries fabric lines (quantity is per piece).
      const costing = new Map<number, { no: string; lines: { fabric: number | null; kg: number }[] }>();
      // BOM: approved/active first, then latest version; consumption converted to KG per piece.
      const boms = new Map<number, { so: number | null; no: string; lines: { fabric: number | null; kg: number }[] }[]>();
      if (styleIds.length) {
        const cl = await run(
          `SELECT c.id, c.style_id, c.costing_no, l.ref_material_id, l.quantity, u.code AS uom
             FROM trx_costing c
             JOIN trx_costing_line l ON l.costing_id = c.id
             LEFT JOIN cfg_uom u ON u.id = l.uom_id
            WHERE c.company_id = ? AND c.style_id IN (?) AND l.material_type = 'FABRIC'
            ORDER BY c.style_id, c.version DESC, c.id DESC`, [cid, styleIds]);
        const pickedCosting = new Map<number, number>();
        for (const l of cl) {
          const kg = toKg(l.quantity, l.uom);
          if (kg == null) continue;
          if (!pickedCosting.has(l.style_id)) pickedCosting.set(l.style_id, l.id);
          if (pickedCosting.get(l.style_id) !== l.id) continue;
          const e = costing.get(l.style_id) ?? { no: l.costing_no as string, lines: [] as { fabric: number | null; kg: number }[] };
          e.lines.push({ fabric: l.ref_material_id ?? null, kg });
          costing.set(l.style_id, e);
        }
        const bl = await run(
          `SELECT b.id, b.style_id, b.so_id, b.bom_no, l.fabric_id, l.consumption, l.consumption_basis, u.code AS uom
             FROM trx_bom b
             JOIN trx_bom_line l ON l.bom_id = b.id
             LEFT JOIN cfg_uom u ON u.id = l.uom_id
            WHERE b.company_id = ? AND b.style_id IN (?) AND l.material_type = 'FABRIC'
              AND COALESCE(b.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'SUPERSEDED')
            ORDER BY b.style_id, (b.approval_state = 'APPROVED') DESC, b.is_active DESC, b.version DESC, b.id DESC`,
          [cid, styleIds]);
        const byId = new Map<number, { style: number; so: number | null; no: string; lines: { fabric: number | null; kg: number }[] }>();
        for (const l of bl) {
          const basis = String(l.consumption_basis || 'PER_PIECE').toUpperCase();
          if (basis === 'FIXED_QTY') continue;
          let kg = toKg(l.consumption, l.uom);
          if (kg == null) continue;
          if (basis === 'PER_DOZEN') kg /= 12;
          const e = byId.get(l.id) ?? { style: l.style_id as number, so: (l.so_id ?? null) as number | null, no: l.bom_no as string, lines: [] as { fabric: number | null; kg: number }[] };
          e.lines.push({ fabric: l.fabric_id ?? null, kg });
          byId.set(l.id, e);
        }
        for (const b of byId.values()) {
          const list = boms.get(b.style) ?? [];
          list.push(b);
          boms.set(b.style, list);
        }
      }
      /** KG/PC for a cut order's fabric; if no line matches the fabric, all fabric lines. */
      const kgFor = (lines: { fabric: number | null; kg: number }[], fabricId: number | null) => {
        const match = fabricId ? lines.filter((l) => l.fabric === fabricId) : [];
        const use = match.length ? match : lines;
        return use.length ? use.reduce((a, l) => a + l.kg, 0) : null;
      };

      for (const r of rows) {
        const c = costing.get(r.style_id);
        const bList = boms.get(r.style_id) ?? [];
        const b = bList.find((x) => r.so_id && x.so === r.so_id) ?? bList[0];
        r.costing_ref = c?.no ?? null;
        r.costing_kg_per_pc = c ? round(kgFor(c.lines, r.fabric_id), 4) : null;
        r.bom_ref = b?.no ?? null;
        r.bom_kg_per_pc = b ? round(kgFor(b.lines, r.fabric_id), 4) : null;
        r.marker_kg_per_pc = round(n(r.marker_kg_per_pc), 4);
        r.planned_source = r.costing_kg_per_pc != null ? 'COSTING' : r.bom_kg_per_pc != null ? 'BOM' : null;
        r.planned_kg_per_pc = r.costing_kg_per_pc ?? r.bom_kg_per_pc;
        const act = r.actual_kg_per_pc as number | null;
        r.variance_kg_per_pc = act != null && r.planned_kg_per_pc != null ? round(act - r.planned_kg_per_pc, 4) : null;
        r.variance_pct = r.variance_kg_per_pc == null ? null : pct(r.variance_kg_per_pc, r.planned_kg_per_pc);
        r.variance_kg = r.variance_kg_per_pc == null ? null : round(r.variance_kg_per_pc * Number(r.actual_cut_qty), 3);
        r.marker_variance_kg_per_pc = act != null && r.marker_kg_per_pc != null ? round(act - r.marker_kg_per_pc, 4) : null;
        // Final actual (§17): fabric that did not come back (net issued − remnant) ÷ good pieces,
        // only once the cut order is reconciled.
        const reconciled = ['APPROVED', 'CLOSED'].includes(r.recon_status) || r.status === 'CLOSED';
        r.final_actual_kg_per_pc = reconciled
          ? ratio(Number(r.net_issued_kg) - Number(r.remnant_kg), Number(r.actual_cut_qty)) : null;
      }
      const columns: Col[] = [
        ...PLAN_ID_COLS,
        { key: 'actual_cut_qty', label: 'Cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'consumed_kg', label: 'Consumed', type: 'kg', uom: 'KG', sum: true },
        { key: 'costing_kg_per_pc', label: 'Costing', type: 'kgpc', uom: 'KG/PC' },
        { key: 'bom_kg_per_pc', label: 'BOM', type: 'kgpc', uom: 'KG/PC' },
        { key: 'marker_kg_per_pc', label: 'Marker', type: 'kgpc', uom: 'KG/PC' },
        { key: 'actual_kg_per_pc', label: 'Cutting Actual', type: 'kgpc', uom: 'KG/PC' },
        { key: 'final_actual_kg_per_pc', label: 'Final Actual', type: 'kgpc', uom: 'KG/PC' },
        { key: 'planned_source', label: 'Planned Basis' },
        { key: 'variance_kg_per_pc', label: 'Variance', type: 'kgpc', uom: 'KG/PC' },
        { key: 'variance_pct', label: 'Variance', type: 'pct', uom: '%' },
        { key: 'variance_kg', label: 'Variance', type: 'kg', uom: 'KG', sum: true },
        { key: 'marker_variance_kg_per_pc', label: 'Actual − Marker', type: 'kgpc', uom: 'KG/PC' },
        { key: 'costing_ref', label: 'Costing Ref' },
        { key: 'bom_ref', label: 'BOM Ref' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      totals.actual_kg_per_pc = ratio(totals.consumed_kg ?? 0, totals.actual_cut_qty ?? 0);
      return { columns, rows, totals, notes: [
        'Planned = Costing KG/PC (falls back to BOM). Variance = Cutting Actual − Planned; Variance % = Variance ÷ Planned × 100.',
        'Final Actual = (Issued − Returned − Remnant) ÷ cut PCS, shown once the cut order is reconciled.',
      ] };
    },
  },

  // 8 ─────────────────────────────────────────────────────────────────────
  {
    key: 'wastage-remnant',
    title: 'Cutting Wastage & Remnant',
    async run(run, cid, f) {
      const rows = (await planBalance(run, cid, f))
        .filter((r) => Number(r.issued_kg) > 0 || Number(r.total_loss_kg) > 0);
      for (const r of rows) {
        const iss = Number(r.issued_kg);
        r.waste_pct = pct(Number(r.cutting_waste_kg), iss);
        r.end_loss_pct = pct(Number(r.end_loss_kg), iss);
        r.selvedge_pct = pct(Number(r.selvedge_kg), iss);
        r.remnant_pct = pct(Number(r.remnant_kg), iss);
        r.other_pct = pct(Number(r.other_loss_kg), iss);
        r.total_loss_pct = pct(Number(r.total_loss_kg), iss);
      }
      const columns: Col[] = [
        ...PLAN_ID_COLS,
        { key: 'issued_kg', label: 'Issued', type: 'kg', uom: 'KG', sum: true },
        { key: 'cutting_waste_kg', label: 'Cutting Waste', type: 'kg', uom: 'KG', sum: true },
        { key: 'waste_pct', label: 'Waste', type: 'pct', uom: '%' },
        { key: 'end_loss_kg', label: 'End Loss', type: 'kg', uom: 'KG', sum: true },
        { key: 'end_loss_pct', label: 'End Loss', type: 'pct', uom: '%' },
        { key: 'selvedge_kg', label: 'Selvedge', type: 'kg', uom: 'KG', sum: true },
        { key: 'selvedge_pct', label: 'Selvedge', type: 'pct', uom: '%' },
        { key: 'remnant_kg', label: 'Remnant', type: 'kg', uom: 'KG', sum: true },
        { key: 'remnant_pct', label: 'Remnant', type: 'pct', uom: '%' },
        { key: 'other_loss_kg', label: 'Other', type: 'kg', uom: 'KG', sum: true },
        { key: 'other_pct', label: 'Other', type: 'pct', uom: '%' },
        { key: 'total_loss_kg', label: 'Total Loss', type: 'kg', uom: 'KG', sum: true },
        { key: 'total_loss_pct', label: 'Total Loss', type: 'pct', uom: '% of issued' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      const iss = totals.issued_kg ?? 0;
      totals.waste_pct = pct(totals.cutting_waste_kg ?? 0, iss);
      totals.end_loss_pct = pct(totals.end_loss_kg ?? 0, iss);
      totals.selvedge_pct = pct(totals.selvedge_kg ?? 0, iss);
      totals.remnant_pct = pct(totals.remnant_kg ?? 0, iss);
      totals.other_pct = pct(totals.other_loss_kg ?? 0, iss);
      totals.total_loss_pct = pct(totals.total_loss_kg ?? 0, iss);
      return { columns, rows, totals, notes: ['Percentages are of issued KG. Reversed loss entries are excluded.'] };
    },
  },

  // 9 ─────────────────────────────────────────────────────────────────────
  {
    key: 'bundle-traceability',
    title: 'Bundle Traceability',
    async run(run, cid, f) {
      const w = bundleWhere(f);
      const rows = await run(
        `SELECT cb.bundle_no, cb.barcode, cb.io_no, st.style_code, clr.color_name, sz.size_code,
                cb.qty, cb.balance_qty, cb.allocated_kg, cb.allocation_method,
                co.output_no, lp.lay_no, cp.plan_no,
                CONCAT(mv.marker_no, ' v', mv.version) AS marker,
                (SELECT GROUP_CONCAT(DISTINCT lr.roll_no ORDER BY lr.roll_no SEPARATOR ', ')
                   FROM trx_lay_roll lr WHERE lr.lay_id = cb.lay_id) AS roll_nos,
                (SELECT GROUP_CONCAT(DISTINCT lr.lot_no ORDER BY lr.lot_no SEPARATOR ', ')
                   FROM trx_lay_roll lr WHERE lr.lay_id = cb.lay_id) AS lot_nos,
                pb.bundle_no AS parent_bundle_no,
                (SELECT bm.to_stage FROM trx_bundle_movement bm
                  WHERE bm.bundle_id = cb.id ORDER BY bm.moved_at DESC, bm.id DESC LIMIT 1) AS current_stage,
                (SELECT GROUP_CONCAT(DISTINCT ct.carton_no SEPARATOR ', ')
                   FROM trx_carton_bundle ctb JOIN trx_carton ct ON ct.id = ctb.carton_id
                  WHERE ctb.bundle_id = cb.id) AS cartons,
                (SELECT GROUP_CONCAT(DISTINCT sh.shipment_no SEPARATOR ', ')
                   FROM trx_carton_bundle ctb
                   JOIN trx_shipment_package sp ON sp.carton_id = ctb.carton_id AND sp.status <> 'CANCELLED'
                   JOIN trx_shipment sh ON sh.id = sp.shipment_id
                  WHERE ctb.bundle_id = cb.id) AS shipments,
                cb.status, cb.created_at
           ${BUNDLE_FROM}
          WHERE cb.company_id = ?${w.sql}
          ORDER BY cb.created_at DESC, cb.id DESC
          LIMIT ${MAX_ROWS + 1}`, [cid, ...w.params]);
      const columns: Col[] = [
        { key: 'bundle_no', label: 'Bundle', link: 'bundle' },
        { key: 'barcode', label: 'Barcode' },
        { key: 'io_no', label: 'IO No' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'size_code', label: 'Size' },
        { key: 'qty', label: 'Qty', type: 'int', uom: 'PCS', sum: true },
        { key: 'balance_qty', label: 'Balance', type: 'int', uom: 'PCS', sum: true },
        { key: 'allocated_kg', label: 'Allocated Fabric', type: 'kg', uom: 'KG (calc.)', sum: true },
        { key: 'plan_no', label: 'Cut Order' },
        { key: 'lay_no', label: 'Lay' },
        { key: 'output_no', label: 'Cut Output' },
        { key: 'marker', label: 'Marker' },
        { key: 'roll_nos', label: 'Rolls', link: 'roll' },
        { key: 'lot_nos', label: 'Lots' },
        { key: 'parent_bundle_no', label: 'Parent Bundle' },
        { key: 'current_stage', label: 'Current Stage' },
        { key: 'cartons', label: 'Cartons' },
        { key: 'shipments', label: 'Shipments' },
        { key: 'status', label: 'Status' },
      ];
      return { columns, rows, notes: ['Allocated fabric is calculated from lay consumption — not a physical bundle weight.'] };
    },
  },

  // 10 ────────────────────────────────────────────────────────────────────
  {
    key: 'bundle-aging',
    title: 'Bundle Status / Aging',
    async run(run, cid, f) {
      const w = bundleWhere(f);
      // Without an explicit status, finished bundles are not "aging".
      if (!f.status) w.add(`cb.status NOT IN ('SHIPPED','CLOSED','CANCELLED','SPLIT')`);
      const rows = await run(
        `SELECT cb.bundle_no, cb.io_no, st.style_code, clr.color_name, sz.size_code, cp.plan_no,
                cb.qty, cb.balance_qty, cb.status, mvx.to_stage AS current_stage,
                mvx.location, cb.created_at, mvx.moved_at AS last_movement_at,
                DATEDIFF(CURDATE(), DATE(cb.created_at)) AS age_days,
                DATEDIFF(CURDATE(), DATE(COALESCE(mvx.moved_at, cb.created_at))) AS idle_days
           ${BUNDLE_FROM}
           LEFT JOIN trx_bundle_movement mvx ON mvx.id = (
             SELECT bm.id FROM trx_bundle_movement bm WHERE bm.bundle_id = cb.id
              ORDER BY bm.moved_at DESC, bm.id DESC LIMIT 1)
          WHERE cb.company_id = ?${w.sql}
          ORDER BY idle_days DESC, cb.id
          LIMIT ${MAX_ROWS + 1}`, [cid, ...w.params]);
      for (const r of rows) {
        const d = Number(r.idle_days);
        r.aging_bucket = d <= 3 ? '0–3 days' : d <= 7 ? '4–7 days' : d <= 15 ? '8–15 days' : '> 15 days';
      }
      const columns: Col[] = [
        { key: 'bundle_no', label: 'Bundle', link: 'bundle' },
        { key: 'io_no', label: 'IO No' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'size_code', label: 'Size' },
        { key: 'plan_no', label: 'Cut Order' },
        { key: 'qty', label: 'Qty', type: 'int', uom: 'PCS', sum: true },
        { key: 'balance_qty', label: 'Balance', type: 'int', uom: 'PCS', sum: true },
        { key: 'status', label: 'Status' },
        { key: 'current_stage', label: 'Stage' },
        { key: 'location', label: 'Location' },
        { key: 'created_at', label: 'Created', type: 'datetime' },
        { key: 'last_movement_at', label: 'Last Movement', type: 'datetime' },
        { key: 'age_days', label: 'Age', type: 'days', uom: 'days' },
        { key: 'idle_days', label: 'Since Last Move', type: 'days', uom: 'days' },
        { key: 'aging_bucket', label: 'Bucket' },
      ];
      return { columns, rows };
    },
  },

  // 11 ────────────────────────────────────────────────────────────────────
  {
    key: 'lot-to-shipment',
    title: 'Fabric Lot → Shipment Traceability',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'lp.lay_date');
      if (f.io_no) w.add('COALESCE(lp.io_no, cp.io_no) LIKE ?', like(f.io_no));
      if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.lot_no) w.add('ll.lot_no LIKE ?', like(f.lot_no));
      if (f.roll_no) w.add('EXISTS (SELECT 1 FROM trx_lay_roll lr_x WHERE lr_x.lay_id = ll.lay_id AND lr_x.roll_no LIKE ?)', like(f.roll_no));
      if (f.status) w.add('lp.status = ?', f.status.toUpperCase());
      const rows = await run(
        `SELECT ll.lot_no,
                GROUP_CONCAT(DISTINCT fb.fabric_name SEPARATOR ', ') AS fabric_name,
                MAX(lk.rolls) AS roll_count, MAX(lk.kg) AS consumed_kg,
                COUNT(DISTINCT ll.lay_id) AS lay_count,
                GROUP_CONCAT(DISTINCT cp.plan_no ORDER BY cp.plan_no SEPARATOR ', ') AS cut_orders,
                GROUP_CONCAT(DISTINCT COALESCE(lp.io_no, cp.io_no) SEPARATOR ', ') AS io_nos,
                GROUP_CONCAT(DISTINCT st.style_code SEPARATOR ', ') AS styles,
                SUM(COALESCE(ba.bundles, 0)) AS bundle_count,
                SUM(COALESCE(ba.pcs, 0)) AS bundle_pcs,
                SUM(COALESCE(ba.kg, 0)) AS allocated_kg,
                SUM(COALESCE(pa.cartons, 0)) AS carton_count,
                SUM(COALESCE(pa.packed, 0)) AS packed_pcs,
                SUM(COALESCE(pa.shipped, 0)) AS shipped_pcs,
                GROUP_CONCAT(DISTINCT pa.shipments SEPARATOR ', ') AS shipments
           FROM (SELECT DISTINCT COALESCE(NULLIF(lr.lot_no, ''), fr.lot_no, '(no lot)') AS lot_no, lr.lay_id
                   FROM trx_lay_roll lr LEFT JOIN trx_fabric_roll fr ON fr.id = lr.fabric_roll_id
                  WHERE lr.company_id = ?) ll
           JOIN trx_lay_plan lp ON lp.id = ll.lay_id AND lp.status <> 'CANCELLED'
           LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
           LEFT JOIN mst_style st ON st.id = COALESCE(lp.style_id, cp.style_id)
           LEFT JOIN mst_fabric fb ON fb.id = COALESCE(lp.fabric_id, cp.fabric_id)
           LEFT JOIN (SELECT COALESCE(NULLIF(lr.lot_no, ''), fr.lot_no, '(no lot)') AS lot_no,
                             COUNT(DISTINCT COALESCE(lr.fabric_roll_id, lr.roll_no)) AS rolls,
                             SUM(lr.actual_consumed_kg) AS kg
                        FROM trx_lay_roll lr
                        JOIN trx_lay_plan lp0 ON lp0.id = lr.lay_id AND lp0.status <> 'CANCELLED'
                        LEFT JOIN trx_fabric_roll fr ON fr.id = lr.fabric_roll_id
                       WHERE lr.company_id = ?
                       GROUP BY 1) lk ON lk.lot_no = ll.lot_no
           LEFT JOIN (SELECT lay_id, COUNT(*) AS bundles, SUM(qty) AS pcs, SUM(allocated_kg) AS kg
                        FROM trx_cutting_bundle
                       WHERE company_id = ? AND status NOT IN ('CANCELLED','SPLIT') AND lay_id IS NOT NULL
                       GROUP BY lay_id) ba ON ba.lay_id = ll.lay_id
           LEFT JOIN (${PACK_BY_LAY}) pa ON pa.lay_id = ll.lay_id
          WHERE 1 = 1${w.sql}
          GROUP BY ll.lot_no
          ORDER BY ll.lot_no
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, cid, cid, ...w.params]);
      const columns: Col[] = [
        { key: 'lot_no', label: 'Lot No', link: 'lot' },
        { key: 'fabric_name', label: 'Fabric' },
        { key: 'roll_count', label: 'Rolls', type: 'int', sum: true },
        { key: 'consumed_kg', label: 'Consumed', type: 'kg', uom: 'KG', sum: true },
        { key: 'lay_count', label: 'Lays', type: 'int', sum: true },
        { key: 'cut_orders', label: 'Cut Orders' },
        { key: 'io_nos', label: 'IO No' },
        { key: 'styles', label: 'Styles' },
        { key: 'bundle_count', label: 'Bundles', type: 'int', sum: true },
        { key: 'bundle_pcs', label: 'Bundle Qty', type: 'int', uom: 'PCS', sum: true },
        { key: 'allocated_kg', label: 'Allocated', type: 'kg', uom: 'KG (calc.)', sum: true },
        { key: 'carton_count', label: 'Cartons', type: 'int', sum: true },
        { key: 'packed_pcs', label: 'Packed', type: 'int', uom: 'PCS', sum: true },
        { key: 'shipped_pcs', label: 'Shipped', type: 'int', uom: 'PCS', sum: true },
        { key: 'shipments', label: 'Shipments' },
      ];
      return { columns, rows, notes: [
        'Bundles, cartons and shipments are counted for every lay that used the lot; a lay spread from several lots appears under each lot.',
      ] };
    },
  },

  // 12 ────────────────────────────────────────────────────────────────────
  {
    key: 'shipment-to-roll',
    title: 'Shipment → Fabric Roll Reverse Traceability',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'sh.created_at');
      if (f.io_no) w.add('COALESCE(sh.io_no, cb.io_no) LIKE ?', like(f.io_no));
      if (f.shipment) w.add('sh.shipment_no LIKE ?', like(f.shipment));
      if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
      styleFilter(w, f);
      fabricFilter(w, f);
      if (f.lot_no) w.add('lr.lot_no LIKE ?', like(f.lot_no));
      if (f.roll_no) w.add('lr.roll_no LIKE ?', like(f.roll_no));
      if (f.status) w.add('sh.tracking_status = ?', f.status.toUpperCase());
      const rows = await run(
        `SELECT sh.shipment_no, DATE(sh.created_at) AS shipment_date, sh.io_no,
                (SELECT pl.pl_no FROM trx_packing_list pl WHERE pl.id = sh.packing_list_id) AS packing_list_no,
                lr.roll_no, lr.lot_no, MAX(fb.fabric_name) AS fabric_name,
                GROUP_CONCAT(DISTINCT lp.lay_no ORDER BY lp.lay_no SEPARATOR ', ') AS lays,
                GROUP_CONCAT(DISTINCT cp.plan_no ORDER BY cp.plan_no SEPARATOR ', ') AS cut_orders,
                GROUP_CONCAT(DISTINCT st.style_code SEPARATOR ', ') AS styles,
                COUNT(DISTINCT sp.carton_id) AS carton_count,
                COUNT(DISTINCT cb.id) AS bundle_count,
                SUM(ctb.qty) AS shipped_pcs,
                SUM(COALESCE(cb.allocated_kg, 0) * ctb.qty / NULLIF(cb.qty, 0)) AS allocated_kg,
                sh.tracking_status AS status
           FROM trx_shipment sh
           JOIN trx_shipment_package sp ON sp.shipment_id = sh.id AND sp.status <> 'CANCELLED'
           JOIN trx_carton_bundle ctb ON ctb.carton_id = sp.carton_id
           JOIN trx_cutting_bundle cb ON cb.id = ctb.bundle_id
           LEFT JOIN trx_lay_plan lp ON lp.id = cb.lay_id
           LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
           LEFT JOIN mst_style st ON st.id = cb.style_id
           LEFT JOIN (SELECT DISTINCT lay_id, fabric_roll_id, roll_no, lot_no
                        FROM trx_lay_roll WHERE company_id = ?) lr ON lr.lay_id = cb.lay_id
           LEFT JOIN trx_fabric_roll fr ON fr.id = lr.fabric_roll_id
           LEFT JOIN mst_fabric fb ON fb.id = COALESCE(fr.fabric_id, lp.fabric_id, cp.fabric_id)
          WHERE sh.company_id = ?${w.sql}
          GROUP BY sh.id, lr.fabric_roll_id, lr.roll_no, lr.lot_no
          ORDER BY sh.created_at DESC, sh.id DESC, lr.lot_no, lr.roll_no
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, ...w.params]);
      const columns: Col[] = [
        { key: 'shipment_no', label: 'Shipment' },
        { key: 'shipment_date', label: 'Date', type: 'date' },
        { key: 'io_no', label: 'IO No' },
        { key: 'packing_list_no', label: 'Packing List' },
        { key: 'roll_no', label: 'Roll No', link: 'roll' },
        { key: 'lot_no', label: 'Lot No', link: 'lot' },
        { key: 'fabric_name', label: 'Fabric' },
        { key: 'lays', label: 'Lays' },
        { key: 'cut_orders', label: 'Cut Orders' },
        { key: 'styles', label: 'Styles' },
        { key: 'carton_count', label: 'Cartons', type: 'int' },
        { key: 'bundle_count', label: 'Bundles', type: 'int' },
        { key: 'shipped_pcs', label: 'Shipped', type: 'int', uom: 'PCS' },
        { key: 'allocated_kg', label: 'Allocated', type: 'kg', uom: 'KG (calc.)' },
        { key: 'status', label: 'Status' },
      ];
      return { columns, rows, notes: [
        'One row per shipment × roll. Shipped PCS are the packed pieces from lays that used the roll, so a lay spread from several rolls is shown under each roll — do not add rows across rolls.',
      ] };
    },
  },

  // 13 ────────────────────────────────────────────────────────────────────
  {
    key: 'unaccounted-fabric',
    title: 'Unaccounted Fabric',
    async run(run, cid, f) {
      const tol = await tolerancePct(run, cid);
      const onlyExceptions = f.exceptions_only !== '0';
      const all = (await planBalance(run, cid, f)).filter((r) => Number(r.issued_kg) > 0);
      const rows = [];
      for (const r of all) {
        r.tolerance_pct = tol;
        r.tolerance_kg = round((Number(r.issued_kg) * tol) / 100, 4);
        r.breach = Math.abs(Number(r.unaccounted_kg)) > Number(r.tolerance_kg) + 1e-9 ? 'OVER TOLERANCE' : 'WITHIN';
        if (!onlyExceptions || r.breach !== 'WITHIN') rows.push(r);
      }
      const columns: Col[] = [
        ...PLAN_ID_COLS,
        { key: 'status', label: 'Status' },
        { key: 'issued_kg', label: 'Issued', type: 'kg', uom: 'KG', sum: true },
        { key: 'returned_kg', label: 'Returned', type: 'kg', uom: 'KG', sum: true },
        { key: 'consumed_kg', label: 'Consumed', type: 'kg', uom: 'KG', sum: true },
        { key: 'total_loss_kg', label: 'Recorded Losses', type: 'kg', uom: 'KG', sum: true },
        { key: 'unaccounted_kg', label: 'Unaccounted', type: 'kg', uom: 'KG', sum: true },
        { key: 'unaccounted_pct', label: 'Unaccounted', type: 'pct', uom: '% of issued' },
        { key: 'tolerance_kg', label: 'Tolerance', type: 'kg', uom: 'KG', sum: true },
        { key: 'breach', label: 'Result' },
        { key: 'recon_no', label: 'Recon No' },
        { key: 'recon_status', label: 'Recon Status' },
        { key: 'recon_unaccounted_kg', label: 'Recon Unaccounted', type: 'kg', uom: 'KG' },
      ];
      return { columns, rows, notes: [
        `Tolerance ${tol}% of issued KG (setting CUTTING_RECON_TOLERANCE_PCT).`
        + (onlyExceptions ? ' Showing only cut orders outside tolerance.' : ''),
      ] };
    },
  },

  // 14 ────────────────────────────────────────────────────────────────────
  {
    key: 'recut-reject',
    title: 'Re-cut / Reject',
    async run(run, cid, f) {
      const w = new Where();
      dateFilter(w, f, 'u.doc_date');
      if (f.io_no) w.add('u.io_no LIKE ?', like(f.io_no));
      if (f.cut_order) w.add('u.plan_no LIKE ?', like(f.cut_order));
      if (f.style) w.add('(u.style_code LIKE ? OR u.style_name LIKE ?)', like(f.style), like(f.style));
      if (f.fabric) w.add('(u.fabric_code LIKE ? OR u.fabric_name LIKE ?)', like(f.fabric), like(f.fabric));
      if (f.status) w.add('u.status = ?', f.status.toUpperCase());
      layLotRollFilter(w, f, 'u.lay_id');
      const common = `st.style_code, st.style_name, clr.color_name, sz.size_code,
                      fb.fabric_code, fb.fabric_name, cp.plan_no`;
      const rows = await run(
        `SELECT u.source, u.ref_no, u.doc_date, u.plan_no, u.lay_no, u.io_no, u.style_code, u.color_name,
                u.size_code, u.component, u.cut_qty, u.good_qty, u.reject_qty, u.recut_qty, u.reason, u.status
           FROM (
             SELECT 'CUT OUTPUT' AS source, co.output_no AS ref_no, co.created_at AS doc_date,
                    co.lay_id, lp.lay_no, COALESCE(co.io_no, cp.io_no) AS io_no, ${common},
                    NULL AS component, co.good_qty + co.reject_qty AS cut_qty, co.good_qty,
                    co.reject_qty, co.recut_qty, NULL AS reason, co.status
               FROM trx_cut_output co
               LEFT JOIN trx_lay_plan lp ON lp.id = co.lay_id
               LEFT JOIN trx_cutting_plan cp ON cp.id = co.cutting_plan_id
               LEFT JOIN mst_style st ON st.id = COALESCE(co.style_id, cp.style_id)
               LEFT JOIN mst_color clr ON clr.id = COALESCE(co.color_id, cp.color_id)
               LEFT JOIN mst_size sz ON sz.id = co.size_id
               LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
              WHERE co.company_id = ? AND co.status <> 'REVERSED' AND (co.reject_qty > 0 OR co.recut_qty > 0)
             UNION ALL
             SELECT 'CUT PIECE QC', q.qc_no, q.qc_date, c.lay_id, lp.lay_no, COALESCE(q.io_no, cp.io_no), ${common},
                    q.component, q.cut_qty, q.accepted_qty, q.reject_qty, q.recut_qty, q.reject_reason, q.qc_status
               FROM trx_cut_piece_qc q
               LEFT JOIN trx_cutting c ON c.id = q.cutting_id
               LEFT JOIN trx_lay_plan lp ON lp.id = c.lay_id
               LEFT JOIN trx_cutting_plan cp ON cp.id = c.cutting_plan_id
               LEFT JOIN mst_style st ON st.id = COALESCE(q.style_id, cp.style_id)
               LEFT JOIN mst_color clr ON clr.id = COALESCE(q.color_id, cp.color_id)
               LEFT JOIN mst_size sz ON sz.id = q.size_id
               LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
              WHERE q.company_id = ? AND (q.reject_qty > 0 OR q.recut_qty > 0)
           ) u
          WHERE 1 = 1${w.sql}
          ORDER BY u.doc_date DESC
          LIMIT ${MAX_ROWS + 1}`, [cid, cid, ...w.params]);
      for (const r of rows) r.reject_pct = pct(Number(r.reject_qty), Number(r.cut_qty));
      const columns: Col[] = [
        { key: 'source', label: 'Source' },
        { key: 'ref_no', label: 'Ref No' },
        { key: 'doc_date', label: 'Date', type: 'date' },
        { key: 'plan_no', label: 'Cut Order' },
        { key: 'lay_no', label: 'Lay' },
        { key: 'io_no', label: 'IO No' },
        { key: 'style_code', label: 'Style' },
        { key: 'color_name', label: 'Color' },
        { key: 'size_code', label: 'Size' },
        { key: 'component', label: 'Component' },
        { key: 'cut_qty', label: 'Checked', type: 'int', uom: 'PCS', sum: true },
        { key: 'good_qty', label: 'Good', type: 'int', uom: 'PCS', sum: true },
        { key: 'reject_qty', label: 'Reject', type: 'int', uom: 'PCS', sum: true },
        { key: 'recut_qty', label: 'Re-cut', type: 'int', uom: 'PCS', sum: true },
        { key: 'reject_pct', label: 'Reject', type: 'pct', uom: '%' },
        { key: 'reason', label: 'Reason' },
        { key: 'status', label: 'Status' },
      ];
      const totals = sumTotals(rows, columns);
      totals.reject_pct = pct(totals.reject_qty ?? 0, totals.cut_qty ?? 0);
      return { columns, rows, totals, notes: [
        'Cut-output and cut-piece-QC rows are separate recording points; the same pieces may appear in both.',
      ] };
    },
  },
];

// ─── bundle query fragments (reports 9, 10) ─────────────────────────────────

const BUNDLE_FROM = `
       FROM trx_cutting_bundle cb
       LEFT JOIN trx_lay_plan lp ON lp.id = cb.lay_id
       LEFT JOIN trx_cutting ctg ON ctg.id = cb.cutting_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = COALESCE(lp.cutting_plan_id, ctg.cutting_plan_id)
       LEFT JOIN trx_cut_output co ON co.id = cb.cut_output_id
       LEFT JOIN trx_marker_version mv ON mv.id = COALESCE(cb.marker_version_id, lp.marker_version_id)
       LEFT JOIN trx_cutting_bundle pb ON pb.id = cb.parent_bundle_id
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color clr ON clr.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
       LEFT JOIN mst_fabric fb ON fb.id = COALESCE(lp.fabric_id, cp.fabric_id)`;

function bundleWhere(f: Filters) {
  const w = new Where();
  dateFilter(w, f, 'cb.created_at');
  if (f.io_no) w.add('cb.io_no LIKE ?', like(f.io_no));
  if (f.cut_order) w.add('cp.plan_no LIKE ?', like(f.cut_order));
  if (f.bundle) w.add('(cb.bundle_no LIKE ? OR cb.barcode LIKE ?)', like(f.bundle), like(f.bundle));
  styleFilter(w, f);
  fabricFilter(w, f);
  if (f.status) w.add('cb.status = ?', f.status.toUpperCase());
  layLotRollFilter(w, f, 'cb.lay_id');
  return w;
}

/** Packed / shipped PCS per lay via carton ↔ bundle links. */
const PACK_BY_LAY = `
  SELECT cb.lay_id,
         COUNT(DISTINCT ctb.carton_id) AS cartons,
         SUM(ctb.qty) AS packed,
         SUM(CASE WHEN sp.id IS NOT NULL THEN ctb.qty ELSE 0 END) AS shipped,
         GROUP_CONCAT(DISTINCT sh.shipment_no SEPARATOR ', ') AS shipments
    FROM trx_carton_bundle ctb
    JOIN trx_cutting_bundle cb ON cb.id = ctb.bundle_id
    LEFT JOIN trx_shipment_package sp ON sp.carton_id = ctb.carton_id AND sp.status <> 'CANCELLED'
    LEFT JOIN trx_shipment sh ON sh.id = sp.shipment_id
   WHERE cb.company_id = ? AND cb.lay_id IS NOT NULL
   GROUP BY cb.lay_id`;

/** Weight in KG for a quantity in KG or GM; null for any other unit. */
function toKg(qty: unknown, uom: unknown): number | null {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return null;
  const u = String(uom ?? '').toUpperCase();
  if (u === 'KG') return q;
  if (u === 'GM') return q / 1000;
  return null;
}

// ─── public runner & routes ─────────────────────────────────────────────────

export const CUTTING_REPORTS = REPORTS.map((r) => ({ key: r.key, title: r.title }));

/** Run one report and page it. Exported so tests can pass a transaction-bound executor. */
export async function runCuttingReport(run: Run, cid: number, key: string, rawFilters: unknown) {
  const def = REPORTS.find((r) => r.key === key);
  if (!def) throw NotFound(`Unknown cutting report '${key}'`);
  const parsed = filterSchema.safeParse(rawFilters ?? {});
  if (!parsed.success) {
    throw BadRequest(parsed.error.issues.map((i) => i.message).join('; '), parsed.error.issues);
  }
  const f = parsed.data;
  const res = await def.run(run, cid, f);
  const truncated = res.rows.length > MAX_ROWS;
  const all = normalise(truncated ? res.rows.slice(0, MAX_ROWS) : res.rows, res.columns);
  const totals = res.totals
    ? Object.fromEntries(Object.entries(res.totals).map(([k, v]) => {
        const c = res.columns.find((x) => x.key === k);
        return [k, v == null ? null : c?.type === 'pct' ? round(v, 2) : c?.type === 'kgpc' ? round(v, 4) : v];
      }))
    : sumTotals(all, res.columns);
  const start = (f.page - 1) * f.page_size;
  return {
    report: { key: def.key, title: def.title },
    columns: res.columns,
    data: all.slice(start, start + f.page_size),
    totals,
    notes: res.notes ?? [],
    meta: { page: f.page, page_size: f.page_size, total: all.length, truncated, max_rows: MAX_ROWS },
  };
}

const poolRun: Run = (sql, params) => query(sql, params);

cuttingReportsRouter.get('/cutting-reports', requirePermission('PRODUCTION.VIEW'), (_req, res) => {
  res.json({ success: true, data: CUTTING_REPORTS });
});

cuttingReportsRouter.get('/cutting-reports/:key', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const out = await runCuttingReport(poolRun, req.user!.companyId, String(req.params.key), req.query);
  res.json({ success: true, ...out });
}));
