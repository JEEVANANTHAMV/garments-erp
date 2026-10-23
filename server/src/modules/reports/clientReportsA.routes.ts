/**
 * Client report set A — orders, budget, production, logistics.
 * The client's own report formats (tracker "Business Process(New)" rows 121-158 and the
 * per-report sheets), kept separate from the default /reports set.
 *
 * Every endpoint: GET, REPORT.VIEW, company-scoped, read-only, a fixed number of
 * set-based queries (no per-row queries). Response: { data: rows, meta: { footnotes } }.
 * Each row carries the ids its drill-down links need (so_id, invoice_id, dispatch_id …).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';

export const clientReportsARouter = Router();
const VIEW = requirePermission('REPORT.VIEW');

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const baseQ = z.object({
  dateFrom: ymd.optional(),
  dateTo: ymd.optional(),
  buyer_id: z.coerce.number().int().positive().optional(),
  season: z.string().trim().max(40).optional(),
  status: z.string().trim().max(20).optional(),
  so_id: z.coerce.number().int().positive().optional(),
});

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const inList = (ids: number[]) => (ids.length ? ids : [0]);

/* ------------------------------------------------------------------ shared SQL pieces */

/** Job key (IO no or SO no) → sales order: bundles / DCs / outputs carry the IO, older rows the SO no. */
const IOMAP = `(SELECT id AS so_id, company_id, so_no AS k FROM trx_sales_order WHERE is_deleted = 0
                UNION SELECT id, company_id, io_no FROM trx_sales_order WHERE is_deleted = 0 AND io_no IS NOT NULL AND io_no <> '')`;

/** Shipped (despatched) qty per SO: dispatches, linked directly or through their shipment. */
const SHIPPED = `(SELECT COALESCE(d.so_id, sh.so_id) AS so_id, SUM(d.total_qty) AS qty, MAX(d.dispatch_date) AS last_date
                    FROM trx_dispatch d LEFT JOIN trx_shipment sh ON sh.id = d.shipment_id
                   WHERE d.company_id = ? GROUP BY COALESCE(d.so_id, sh.so_id))`;

/** Produced qty per SO: production orders' produced qty, or FG receipts when higher. */
const PRODUCED = `(SELECT so_id, SUM(q_po) AS q_po, SUM(q_fg) AS q_fg FROM (
                     SELECT so_id, SUM(produced_qty) AS q_po, 0 AS q_fg FROM trx_production_order WHERE company_id = ? AND so_id IS NOT NULL GROUP BY so_id
                     UNION ALL
                     SELECT COALESCE(f.so_id, m.so_id), 0, SUM(f.total_qty) FROM trx_fg_receipt f
                       LEFT JOIN ${IOMAP} m ON f.so_id IS NULL AND m.company_id = f.company_id AND m.k = f.io_no
                      WHERE f.company_id = ? GROUP BY COALESCE(f.so_id, m.so_id)) x
                   WHERE so_id IS NOT NULL GROUP BY so_id)`;

/** Styles of each SO (style codes from its lines). */
const SO_STYLES = `(SELECT sol.so_id, GROUP_CONCAT(DISTINCT st.style_code ORDER BY st.style_code SEPARATOR ', ') AS styles,
                           GROUP_CONCAT(DISTINCT COALESCE(st.description, st.style_name) SEPARATOR ', ') AS style_desc,
                           MIN(sol.style_id) AS style_id, MAX(u.code) AS uom
                      FROM trx_sales_order_line sol
                      JOIN mst_style st ON st.id = sol.style_id
                      LEFT JOIN mst_product p ON p.id = st.product_id
                      LEFT JOIN cfg_uom u ON u.id = p.default_uom
                     GROUP BY sol.so_id)`;

/** Approved pre-costing per style (latest approved version). */
const APPROVED_COSTING = `(SELECT * FROM (
     SELECT c.*, cur.code AS cost_currency,
            ROW_NUMBER() OVER (PARTITION BY c.style_id ORDER BY c.version DESC, c.id DESC) AS rn
       FROM trx_costing c
       JOIN cfg_status st ON st.id = c.status_id AND st.code = 'APPROVED'
       LEFT JOIN cfg_currency cur ON cur.id = c.currency_id
      WHERE c.company_id = ? AND c.is_deleted = 0) z WHERE z.rn = 1)`;

/** SO state filter. Closed includes short-closed (migration 117) when that state exists. */
function stateFilter(status: string | undefined, where: string[]) {
  const s = (status || 'open').toLowerCase();
  if (s === 'open') where.push(`COALESCE(so.approval_state,'DRAFT') NOT IN ('CLOSED','SHORT_CLOSED','CANCELLED','REJECTED')`);
  else if (s === 'closed') where.push(`so.approval_state IN ('CLOSED','SHORT_CLOSED')`);
  else if (s === 'cancelled') where.push(`so.approval_state = 'CANCELLED'`);
}

/** trx_sales_order columns (cached) — lets the closed / cancelled report use migration-117 fields when present. */
let soColsCache: { at: number; cols: Set<string> } | null = null;
async function soColumns(): Promise<Set<string>> {
  if (soColsCache && Date.now() - soColsCache.at < 60_000) return soColsCache.cols;
  const rows = await query<any>(
    `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'trx_sales_order'`);
  soColsCache = { at: Date.now(), cols: new Set(rows.map((r) => String(r.c ?? r.C ?? r.COLUMN_NAME).toLowerCase())) };
  return soColsCache.cols;
}
const firstCol = (cols: Set<string>, names: string[], alias = 'so') =>
  names.filter((c) => cols.has(c)).map((c) => `${alias}.${c}`);

function soFilters(q: z.infer<typeof baseQ>, cid: number, dateCol = 'so.so_date') {
  const where = ['so.company_id = ?', 'so.is_deleted = 0'];
  const params: unknown[] = [cid];
  if (q.buyer_id) { where.push('so.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.season) { where.push('so.season = ?'); params.push(q.season); }
  if (q.so_id) { where.push('so.id = ?'); params.push(q.so_id); }
  if (q.dateFrom) { where.push(`${dateCol} >= ?`); params.push(q.dateFrom); }
  if (q.dateTo) { where.push(`${dateCol} <= ?`); params.push(q.dateTo); }
  return { where, params };
}

/* ================================================================ 1. Orders in hand */
clientReportsARouter.get('/orders-in-hand', VIEW, ah(async (req, res) => {
  const q = baseQ.parse(req.query);
  const cid = req.user!.companyId;
  const { where, params } = soFilters(q, cid);
  stateFilter(q.status, where);
  const rows = await query<any>(`
    SELECT so.id AS so_id, b.party_name AS buyer_name, so.so_no, so.io_no, so.buyer_po_no, so.season, so.order_type,
           sty.styles AS style_no, sty.style_id, so.so_date, COALESCE(so.delivery_date, so.ship_date) AS delivery_date,
           so.order_qty, GREATEST(COALESCE(pr.q_po,0), COALESCE(pr.q_fg,0)) AS prod_qty,
           COALESCE(sty.uom, 'PCS') AS uom,
           COALESCE(sh.qty, 0) AS shipped_qty,
           GREATEST(so.order_qty - COALESCE(sh.qty,0), 0) AS ship_balance,
           cur.code AS currency,
           CASE WHEN so.order_qty > 0 THEN so.total_amount / so.order_qty ELSE 0 END AS unit_price,
           ROUND(GREATEST(so.order_qty - COALESCE(sh.qty,0), 0) * CASE WHEN so.order_qty > 0 THEN so.total_amount / so.order_qty ELSE 0 END, 2) AS balance_value,
           CASE WHEN so.order_qty - COALESCE(sh.qty,0) > 0 AND COALESCE(so.delivery_date, so.ship_date) < CURDATE()
                THEN DATEDIFF(CURDATE(), COALESCE(so.delivery_date, so.ship_date)) ELSE 0 END AS overdue_days,
           so.approval_state AS status
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
      LEFT JOIN ${SO_STYLES} sty ON sty.so_id = so.id
      LEFT JOIN ${PRODUCED} pr ON pr.so_id = so.id
      LEFT JOIN ${SHIPPED} sh ON sh.so_id = so.id
     WHERE ${where.join(' AND ')}
     ORDER BY overdue_days DESC, delivery_date, so.so_no`,
    [cid, cid, cid, ...params]);
  res.json({ data: rows, meta: { footnotes: [
    'Prod Qty = produced qty of the production orders, or finished-goods receipts when higher.',
    'Shipped Qty = despatched qty (despatch entries of the order). Balance value = ship balance × average order price, in the order currency.',
  ] } });
}));

/* ================================================================ 2. Order status */
clientReportsARouter.get('/order-status', VIEW, ah(async (req, res) => {
  const q = baseQ.parse(req.query);
  const cid = req.user!.companyId;
  const { where, params } = soFilters(q, cid);
  stateFilter(q.status, where);
  const sos = await query<any>(`
    SELECT so.id AS so_id, so.so_no, so.io_no, b.party_name AS customer_name, so.buyer_po_no,
           COALESCE(so.ship_date, so.delivery_date) AS planned_despatch_date, so.order_qty,
           COALESCE(sh.qty,0) AS shipped_qty, GREATEST(so.order_qty - COALESCE(sh.qty,0), 0) AS balance_to_despatch,
           so.approval_state AS status
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN ${SHIPPED} sh ON sh.so_id = so.id
     WHERE ${where.join(' AND ')}
     ORDER BY planned_despatch_date, so.so_no`, [cid, ...params]);
  const ids = inList(sos.map((s) => Number(s.so_id)));

  const [reqRows, poRows, grnRows, stage] = await Promise.all([
    // Material requirement: the job's latest requirement revision; MRP requirement where the job has none.
    query<any>(`
      SELECT so_id, material_type, item_id, SUM(req) AS req FROM (
        SELECT j.so_id, j.material_type, COALESCE(j.yarn_id, j.fabric_id, j.trim_id) AS item_id, j.required_qty AS req
          FROM trx_job_material_requirement j
         WHERE j.company_id = ? AND j.so_id IN (?) AND UPPER(COALESCE(j.status,'')) NOT IN ('CANCELLED','VOID')
           AND j.revision_no = (SELECT MAX(x.revision_no) FROM trx_job_material_requirement x WHERE x.so_id = j.so_id AND x.company_id = j.company_id)
        UNION ALL
        SELECT m.so_id, m.material_type, COALESCE(m.yarn_id, m.fabric_id, m.trim_id), m.gross_required
          FROM trx_mrp_requirement m
         WHERE m.so_id IN (?) AND NOT EXISTS (SELECT 1 FROM trx_job_material_requirement x WHERE x.so_id = m.so_id AND x.company_id = ?)
      ) r WHERE item_id IS NOT NULL GROUP BY so_id, material_type, item_id`, [cid, ids, ids, cid]),
    query<any>(`
      SELECT so_id, material_type, item_id, SUM(qty) AS ordered FROM (
        SELECT COALESCE(pl.so_id, po.so_id) AS so_id, pl.material_type, COALESCE(pl.yarn_id, pl.fabric_id, pl.trim_id) AS item_id, pl.qty
          FROM trx_purchase_order_line pl JOIN trx_purchase_order po ON po.id = pl.po_id
         WHERE po.company_id = ? AND po.is_deleted = 0 AND COALESCE(po.approval_state,'') NOT IN ('CANCELLED','REJECTED')
           AND COALESCE(pl.so_id, po.so_id) IN (?)
        UNION ALL
        SELECT tl.so_id, 'TRIM', tl.trim_id, tl.order_qty
          FROM trx_trim_po_line tl JOIN trx_trim_po tp ON tp.id = tl.po_id
         WHERE tp.company_id = ? AND COALESCE(tp.status,'') NOT IN ('CANCELLED','REJECTED') AND tl.so_id IN (?)
      ) p GROUP BY so_id, material_type, item_id`, [cid, ids, cid, ids]),
    query<any>(`
      SELECT so_id, material_type, item_id, SUM(qty) AS received FROM (
        SELECT gl.so_id, gl.material_type, COALESCE(gl.yarn_id, gl.fabric_id, gl.trim_id) AS item_id,
               gl.received_qty - COALESCE(gl.rejected_qty,0) AS qty
          FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
         WHERE g.company_id = ? AND gl.so_id IN (?)
        UNION ALL
        SELECT tl.so_id, 'TRIM', tl.trim_id, tl.received_qty - COALESCE(tl.rejected_qty,0)
          FROM trx_trim_grn_line tl JOIN trx_trim_grn tg ON tg.id = tl.grn_id
         WHERE tg.company_id = ? AND tl.so_id IN (?)
      ) g GROUP BY so_id, material_type, item_id`, [cid, ids, cid, ids]),
    // Furthest progressed quantity per stage
    query<any>(`
      SELECT s.id AS so_id,
             (SELECT COALESCE(SUM(gl.received_qty),0) FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
               WHERE g.company_id = s.company_id AND gl.so_id = s.id AND gl.material_type = 'YARN') AS yarn_qty,
             (SELECT COALESCE(SUM(gl.received_qty),0) FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
               WHERE g.company_id = s.company_id AND gl.so_id = s.id AND gl.material_type = 'FABRIC') AS fabric_qty,
             (SELECT COALESCE(SUM(CASE WHEN cb.status <> 'SPLIT' THEN cb.qty END),0) FROM trx_cutting_bundle cb
               WHERE cb.company_id = s.company_id AND cb.io_no IN (s.so_no, COALESCE(s.io_no, s.so_no))) AS cut_qty,
             GREATEST(
               (SELECT COALESCE(SUM(cb.sew_good_qty),0) FROM trx_cutting_bundle cb
                 WHERE cb.company_id = s.company_id AND cb.io_no IN (s.so_no, COALESCE(s.io_no, s.so_no))),
               (SELECT COALESCE(SUM(f.total_qty),0) FROM trx_fg_receipt f WHERE f.company_id = s.company_id
                 AND (f.so_id = s.id OR (f.so_id IS NULL AND f.io_no IN (s.so_no, COALESCE(s.io_no, s.so_no))))),
               (SELECT COALESCE(SUM(po.produced_qty),0) FROM trx_production_order po WHERE po.so_id = s.id)) AS garment_qty
        FROM trx_sales_order s WHERE s.company_id = ? AND s.id IN (?)`, [cid, ids]),
  ]);

  const key = (r: any) => `${r.so_id}|${r.material_type}|${r.item_id}`;
  const poMap = new Map(poRows.map((r) => [key(r), n(r.ordered)]));
  const grnMap = new Map(grnRows.map((r) => [key(r), n(r.received)]));
  const stageMap = new Map(stage.map((r) => [Number(r.so_id), r]));
  const bySo = new Map<number, any[]>();
  for (const r of reqRows) { const a = bySo.get(Number(r.so_id)) ?? []; a.push(r); bySo.set(Number(r.so_id), a); }
  const poBySo = new Map<number, any[]>();
  for (const r of poRows) { const a = poBySo.get(Number(r.so_id)) ?? []; a.push(r); poBySo.set(Number(r.so_id), a); }

  const data = sos.map((s) => {
    const reqs = bySo.get(Number(s.so_id)) ?? [];
    const pos = poBySo.get(Number(s.so_id)) ?? [];
    let allPo: string | null = null; let allGrn: string | null = null;
    let poPending = 0; let grnPending = 0;
    if (reqs.length) {
      for (const r of reqs) {
        const need = n(r.req) * 0.999;
        if ((poMap.get(key(r)) ?? 0) < need) poPending++;
        if ((grnMap.get(key(r)) ?? 0) < need) grnPending++;
      }
      allPo = poPending ? 'No' : 'Yes'; allGrn = grnPending ? 'No' : 'Yes';
    } else if (pos.length) {
      for (const p of pos) if ((grnMap.get(key(p)) ?? 0) < n(p.ordered) * 0.999) grnPending++;
      allGrn = grnPending ? 'No' : 'Yes';
    }
    const st = stageMap.get(Number(s.so_id)) ?? {};
    const current_stage = n(st.garment_qty) > 0 ? 'Garment' : n(st.cut_qty) > 0 ? 'Cut panel'
      : n(st.fabric_qty) > 0 ? 'Fabric' : n(st.yarn_qty) > 0 ? 'Yarn' : 'Not started';
    return {
      ...s, all_po_raised: allPo, all_goods_received: allGrn,
      req_items: reqs.length, po_pending_items: poPending, grn_pending_items: grnPending,
      yarn_qty: n(st.yarn_qty), fabric_qty: n(st.fabric_qty), cut_qty: n(st.cut_qty), garment_qty: n(st.garment_qty),
      current_stage,
    };
  });
  res.json({ data, meta: { footnotes: [
    'All POs raised / All goods received compare the job\'s material requirement (latest revision, else MRP) item by item with PO qty and GRN qty (received less rejected). Blank = no requirement and no PO for the job.',
    'Current stage = the furthest stage with quantity: Garment (sewn / FG / produced) › Cut panel (cut bundles) › Fabric (fabric GRN) › Yarn (yarn GRN).',
  ] } });
}));

/* ================================================================ 3. Budget vs actuals (OCR / budget sheet / consolidated) */
const bvaQ = baseQ.extend({ group: z.enum(['so', 'buyer']).optional() });

clientReportsARouter.get('/budget-vs-actuals', VIEW, ah(async (req, res) => {
  const q = bvaQ.parse(req.query);
  const cid = req.user!.companyId;
  const { where, params } = soFilters(q, cid);
  stateFilter(q.status || 'all', where);
  const sos = await query<any>(`
    SELECT so.id AS so_id, so.so_no, so.io_no, so.buyer_id, b.party_name AS buyer_name, so.currency_id, cur.code AS currency,
           so.exchange_rate, so.order_qty, so.total_amount, so.approval_state AS status, so.season
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
     WHERE ${where.join(' AND ')}
     ORDER BY so.so_date, so.so_no`, params);
  const ids = inList(sos.map((s) => Number(s.so_id)));

  const [budget, actual, inv, cut, ship, xr, smp] = await Promise.all([
    query<any>(`
      SELECT sol.so_id, SUM(sol.order_qty) AS costed_qty, MAX(pc.currency_id) AS cost_currency_id, MAX(pc.cost_currency) AS cost_currency,
             GROUP_CONCAT(DISTINCT pc.costing_no SEPARATOR ', ') AS costing_nos, MIN(pc.id) AS costing_id,
             SUM(sol.order_qty * (pc.fabric_cost + pc.yarn_cost + pc.knitting_cost + pc.dyeing_cost)) AS y2f,
             SUM(sol.order_qty * (pc.cutting_cost + pc.stitching_cost + pc.finishing_cost + pc.washing_cost + pc.printing_cost + pc.embroidery_cost)) AS cmt,
             SUM(sol.order_qty * pc.trim_cost) AS sew_trims,
             SUM(sol.order_qty * pc.packing_cost) AS pack_trims,
             SUM(sol.order_qty * (pc.testing_cost + pc.freight_cost + pc.agent_commission + pc.finance_cost + pc.other_direct_cost)) AS var_oh,
             SUM(sol.order_qty * pc.overhead_cost) AS fixed_oh
        FROM trx_sales_order_line sol
        JOIN ${APPROVED_COSTING} pc ON pc.style_id = sol.style_id
       WHERE sol.so_id IN (?)
       GROUP BY sol.so_id`, [cid, ids]),
    query<any>(`
      SELECT COALESCE(pc.sales_order_id, po.so_id) AS so_id, COUNT(*) AS cost_sheets,
             GROUP_CONCAT(pc.cost_no SEPARATOR ', ') AS cost_nos, MIN(pc.id) AS cost_id,
             SUM(pc.material_cost - COALESCE(tl.trims,0)) AS y2f,
             SUM(pc.labour_cost + pc.jobwork_cost + pc.process_cost) AS cmt,
             SUM(COALESCE(tl.trims,0)) AS sew_trims,
             SUM(pc.packing_cost) AS pack_trims,
             SUM(pc.overhead_cost + pc.machine_cost) AS fixed_oh
        FROM (SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.prod_order_id
                     ORDER BY (p.status IN ('APPROVED','FINALIZED','LOCKED')) DESC, p.version DESC, p.id DESC) AS rn
                FROM trx_production_cost p WHERE p.company_id = ?) pc
        LEFT JOIN trx_production_order po ON po.id = pc.prod_order_id
        LEFT JOIN (SELECT cost_id, SUM(amount) AS trims FROM trx_production_cost_line
                    WHERE cost_head LIKE 'Trim%' GROUP BY cost_id) tl ON tl.cost_id = pc.id
       WHERE pc.rn = 1 AND COALESCE(pc.sales_order_id, po.so_id) IN (?)
       GROUP BY COALESCE(pc.sales_order_id, po.so_id)`, [cid, ids]),
    query<any>(`
      SELECT ci.so_id, COUNT(*) AS invoices, MIN(ci.id) AS invoice_id,
             SUM(ci.total_value) AS value_fc, SUM(ci.total_value * COALESCE(ci.exchange_rate, 0)) AS value_inr,
             SUM(CASE WHEN ci.exchange_rate > 0 THEN ci.total_value END) AS value_fc_rated,
             DATE_FORMAT(MAX(ci.invoice_date), '%Y-%m') AS inv_month
        FROM trx_commercial_invoice ci WHERE ci.company_id = ? AND ci.so_id IN (?) GROUP BY ci.so_id`, [cid, ids]),
    query<any>(`
      SELECT m.so_id, SUM(cb.qty) AS cut_qty
        FROM trx_cutting_bundle cb JOIN ${IOMAP} m ON m.company_id = cb.company_id AND m.k = cb.io_no
       WHERE cb.company_id = ? AND m.so_id IN (?) AND cb.status <> 'SPLIT'
         AND NOT EXISTS (SELECT 1 FROM trx_bundle_merge_source ms WHERE ms.source_bundle_id = cb.id AND cb.status = 'CLOSED')
       GROUP BY m.so_id`, [cid, ids]),
    query<any>(`SELECT * FROM ${SHIPPED} s WHERE s.so_id IN (?)`, [cid, ids]),
    query<any>(`
      SELECT x.from_currency, x.rate FROM trx_exchange_rate x
        JOIN cfg_currency i ON i.id = x.to_currency AND i.code = 'INR'
       WHERE x.rate_date = (SELECT MAX(y.rate_date) FROM trx_exchange_rate y WHERE y.from_currency = x.from_currency AND y.to_currency = x.to_currency)`),
    // sample development cost allocated to the order (posted, not reversed) — analytical, the sample ledger is the source
    query<any>(`
      SELECT l.so_id, SUM(l.allocated_amount) AS amount, GROUP_CONCAT(DISTINCT s.sample_no ORDER BY s.sample_no SEPARATOR ', ') AS sample_nos
        FROM trx_sample_alloc_line l JOIN trx_sample_alloc_batch b ON b.id = l.batch_id JOIN trx_sample s ON s.id = b.sample_id
       WHERE b.company_id = ? AND l.so_id IN (?) AND l.status = 'ACTIVE' AND b.status IN ('POSTED','PARTIALLY_REVERSED')
       GROUP BY l.so_id`, [cid, ids]),
  ]);
  const m = <T extends { so_id: any }>(rows: T[]) => new Map(rows.map((r) => [Number(r.so_id), r]));
  const B = m(budget), A = m(actual), I = m(inv), C = m(cut), S = m(ship), SM = m(smp);
  const latestXr = new Map(xr.map((r: any) => [Number(r.from_currency), n(r.rate)]));

  type Row = Record<string, any>;
  const rows: Row[] = sos.map((s) => {
    const b = B.get(Number(s.so_id)); const a = A.get(Number(s.so_id)); const iv = I.get(Number(s.so_id));
    // A foreign-currency order saved with rate ≤ 1 has no real rate: use the latest exchange-rate entry, else blank.
    const soFx = s.currency === 'INR' ? 1 : n(s.exchange_rate) > 1 ? n(s.exchange_rate) : latestXr.get(Number(s.currency_id)) ?? null;
    // Pre-costing rates are always ₹ (client 16-Oct-2026: the quote currency only changes how the FOB is quoted;
    // trx_costing heads, total_cost and fob_price are ₹) — no conversion of the budget.
    const costFx: number | null = b ? 1 : null;
    const bud = (v: unknown) => (b && costFx != null ? r2(n(v) * costFx) : null);
    const act = (v: unknown) => (a ? r2(n(v)) : null);
    const order_qty = n(s.order_qty); const cut_qty = n(C.get(Number(s.so_id))?.cut_qty); const ship_qty = n(S.get(Number(s.so_id))?.qty);
    const r: Row = {
      so_id: s.so_id, so_no: s.so_no, io_no: s.io_no, buyer_id: s.buyer_id, buyer_name: s.buyer_name, season: s.season, status: s.status,
      inv_month: iv?.inv_month ?? null, invoice_id: iv?.invoice_id ?? null,
      currency: s.currency, exchange_rate: soFx,
      actual_exrate: iv && n(iv.value_fc_rated) > 0 ? r4(n(iv.value_inr) / n(iv.value_fc_rated)) : null,
      order_qty, cut_qty, ship_qty,
      order_to_cut_diff: cut_qty - order_qty, cut_to_ship_diff: ship_qty - cut_qty, order_to_ship_diff: ship_qty - order_qty,
      sale_budget: soFx != null ? r2(n(s.total_amount) * soFx) : null,
      sale_actual: iv ? r2(n(iv.value_inr)) : null,
      costing_nos: b?.costing_nos ?? null, costing_id: b?.costing_id ?? null,
      cost_nos: a?.cost_nos ?? null, cost_id: a?.cost_id ?? null,
      y2f_budget: bud(b?.y2f), y2f_actual: act(a?.y2f),
      cmt_budget: bud(b?.cmt), cmt_actual: act(a?.cmt),
      sew_trims_budget: bud(b?.sew_trims), sew_trims_actual: act(a?.sew_trims),
      pack_trims_budget: bud(b?.pack_trims), pack_trims_actual: act(a?.pack_trims),
      var_oh_budget: bud(b?.var_oh), var_oh_actual: null,
      fixed_oh_budget: bud(b?.fixed_oh), fixed_oh_actual: act(a?.fixed_oh),
      sample_dev_budget: null, sample_dev_actual: SM.get(Number(s.so_id)) ? r2(n(SM.get(Number(s.so_id))!.amount)) : null,
      sample_nos: SM.get(Number(s.so_id))?.sample_nos ?? null,
    };
    return r;
  });

  const finish = (r: Row): Row => {
    const diff = (x: any, y: any) => (x == null || y == null ? null : r2(n(y) - n(x)));
    const sum = (ks: string[]) => (ks.every((k) => r[k] == null) ? null : r2(ks.reduce((t, k) => t + n(r[k]), 0)));
    const heads = ['y2f', 'cmt', 'sew_trims', 'pack_trims', 'var_oh', 'fixed_oh', 'sample_dev'];
    r.total_exp_budget = sum(heads.map((h) => `${h}_budget`));
    r.total_exp_actual = sum(heads.map((h) => `${h}_actual`));
    r.net_profit_budget = r.sale_budget != null && r.total_exp_budget != null ? r2(r.sale_budget - r.total_exp_budget) : null;
    r.net_profit_actual = r.sale_actual != null && r.total_exp_actual != null ? r2(r.sale_actual - r.total_exp_actual) : null;
    // margin before / after the sample development allocation (spec §6.8)
    r.net_profit_pre_sample_actual = r.net_profit_actual != null ? r2(r.net_profit_actual + n(r.sample_dev_actual)) : null;
    r.sale_diff = diff(r.sale_budget, r.sale_actual);
    for (const h of [...heads, 'total_exp', 'net_profit']) r[`${h}_diff`] = diff(r[`${h}_budget`], r[`${h}_actual`]);
    r.profit_pct_budget = r.net_profit_budget != null && n(r.sale_budget) ? r2((r.net_profit_budget / r.sale_budget) * 100) : null;
    r.profit_pct_actual = r.net_profit_actual != null && n(r.sale_actual) ? r2((r.net_profit_actual / r.sale_actual) * 100) : null;
    r.profit_pct_diff = diff(r.profit_pct_budget, r.profit_pct_actual);
    return r;
  };

  let data: Row[];
  if (q.group === 'buyer') {
    const g = new Map<string, Row>();
    const sumKeys = ['order_qty', 'cut_qty', 'ship_qty', 'order_to_cut_diff', 'cut_to_ship_diff', 'order_to_ship_diff', 'sale_budget', 'sale_actual',
      ...['y2f', 'cmt', 'sew_trims', 'pack_trims', 'var_oh', 'fixed_oh', 'sample_dev'].flatMap((h) => [`${h}_budget`, `${h}_actual`])];
    for (const r of rows) {
      const k = `${r.buyer_id}|${r.inv_month ?? ''}|${r.currency ?? ''}`;
      const t = g.get(k) ?? { buyer_id: r.buyer_id, buyer_name: r.buyer_name, inv_month: r.inv_month, currency: r.currency, so_no: '', orders: 0, so_id: null };
      t.orders += 1; t.so_no = t.so_no ? `${t.so_no}, ${r.so_no}` : r.so_no;
      for (const key of sumKeys) if (r[key] != null) t[key] = r2(n(t[key]) + n(r[key]));
      g.set(k, t);
    }
    data = [...g.values()].map(finish);
  } else data = rows.map(finish);

  res.json({ data, meta: { footnotes: [
    'Budget = latest APPROVED pre-costing of each style × order qty of the sales-order lines, in INR (costing currency × SO exchange rate, or the latest exchange-rate entry; a foreign-currency order without a rate above 1 shows blank INR values). Orders whose style has no approved pre-costing show a blank budget.',
    'Budget heads: Yarn-to-Fab = fabric + yarn + knitting + dyeing; CMT = cutting + stitching + finishing + washing + printing + embroidery; Sew trims = trims; Pack trims = packing; Variable OH = testing + freight + commission + finance + other direct; Fixed OH = overhead.',
    'Actual = production costing sheets of the order\'s production orders (latest approved per production order): Yarn-to-Fab = material less the Trims head; CMT = labour + job work + process; Sew trims = Trims head; Pack trims = packing; Fixed OH = overhead + machine.',
    'Sale value actual and actual exchange rate come from the commercial invoices of the order (value × invoice exchange rate). Blank when not yet invoiced.',
    'Variable OH actual is blank: commission, freight, testing and finance actuals are not posted against orders in the ERP.',
    'Sample dev actual = sample development cost allocated to the order (Samples › Allocation, posted and not reversed). It is an analytical attribution of the posted sample cost ledger — no GL journal, so the sample expense is counted once. Net profit before sample adds it back.',
  ] } });
}));

/* ================================================================ 4. Production output */
const prodQ = baseQ.extend({ source: z.enum(['contractor', 'inhouse']).optional() });

clientReportsARouter.get('/production-output', VIEW, ah(async (req, res) => {
  const q = prodQ.parse(req.query);
  const cid = req.user!.companyId;
  const dateW = (col: string) => {
    const w: string[] = []; const p: unknown[] = [];
    if (q.dateFrom) { w.push(`${col} >= ?`); p.push(q.dateFrom); }
    if (q.dateTo) { w.push(`${col} <= ?`); p.push(q.dateTo); }
    return { w: w.length ? ` AND ${w.join(' AND ')}` : '', p };
  };
  const parts: string[] = []; const params: unknown[] = [];
  {
    // DC inwards always lead the UNION (they name its columns); company shift = own-unit DC.
    const d = dateW('r.receipt_date');
    const shift = q.source === 'contractor' ? ' AND jc.vendor_id IS NOT NULL' : q.source === 'inhouse' ? ' AND jc.vendor_id IS NULL' : '';
    parts.push(`
      SELECT 'DC_INWARD' AS src, r.id AS doc_id, jc.id AS dc_id, r.receipt_no AS doc_no, r.receipt_date AS output_date,
             jc.io_no AS job_key, jc.style_id, jc.stage_id,
             COALESCE(v.party_name, un.unit_name) AS party, CASE WHEN jc.vendor_id IS NULL THEN 'Yes' ELSE 'No' END AS company_shift,
             COALESCE(jc.dc_kind, 'BUNDLE') AS dc_kind, r.received_qty AS output_qty,
             CASE WHEN jc.vendor_id IS NULL THEN NULL ELSE COALESCE(r.rate, jc.rate) END AS bill_rate,
             CASE WHEN jc.vendor_id IS NULL THEN NULL ELSE COALESCE(r.total_amount, r.received_qty * COALESCE(r.rate, jc.rate)) END AS bill_amount,
             COALESCE(un.unit_name, v.party_name) AS production_unit
        FROM trx_jobwork_receipt r
        JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
        LEFT JOIN mst_party v ON v.id = jc.vendor_id
        LEFT JOIN mst_unit un ON un.id = jc.unit_id
       WHERE r.company_id = ? AND COALESCE(jc.status,'') <> 'CANCELLED'${shift}${d.w}`);
    params.push(cid, ...d.p);
  }
  if (q.source !== 'contractor') {
    const d1 = dateW('o.output_date');
    parts.push(`
      SELECT 'SEWING_OUTPUT', MIN(o.id), NULL, MIN(o.output_no), o.output_date, o.io_no, o.style_id,
             (SELECT id FROM cfg_process_stage WHERE stage_code = 'STITCH' LIMIT 1),
             o.line_name, 'Yes', 'GARMENT', SUM(o.output_qty), NULL, NULL, MAX(un.unit_name)
        FROM trx_sewing_output o
        LEFT JOIN cfg_sewing_line sl ON sl.company_id = o.company_id AND (sl.line_code = o.line_name OR sl.line_name = o.line_name)
        LEFT JOIN mst_unit un ON un.id = sl.unit_id
       WHERE o.company_id = ?${d1.w}
       GROUP BY o.output_date, o.io_no, o.style_id, o.line_name`);
    params.push(cid, ...d1.p);
    const d2 = dateW('h.output_date');
    parts.push(`
      SELECT 'SEWING_DAILY', h.id, NULL, h.output_no, h.output_date, l.io_no, l.style_id,
             (SELECT id FROM cfg_process_stage WHERE stage_code = 'STITCH' LIMIT 1),
             COALESCE(sl.line_name, h.floor_name), 'Yes', 'GARMENT', SUM(l.good_qty), NULL, NULL, MAX(un.unit_name)
        FROM trx_sewing_daily_output h
        JOIN trx_sewing_daily_output_line l ON l.output_id = h.id
        LEFT JOIN cfg_sewing_line sl ON sl.id = h.line_id
        LEFT JOIN mst_unit un ON un.id = sl.unit_id
       WHERE h.company_id = ? AND COALESCE(h.status,'') NOT IN ('CANCELLED','DRAFT')${d2.w}
       GROUP BY h.id, l.io_no, l.style_id, sl.line_name, h.floor_name, h.output_no, h.output_date`);
    params.push(cid, ...d2.p);
    const d3 = dateW('o.output_date');
    parts.push(`
      SELECT 'DAILY_OUTPUT', o.id, NULL, o.output_no, o.output_date, COALESCE(o.io_no, so2.so_no), COALESCE(o.style_id, po.style_id), o.stage_id,
             sl.line_name, 'Yes', 'GARMENT', o.actual_good, NULL, NULL, un.unit_name
        FROM trx_daily_output o
        LEFT JOIN trx_production_order po ON po.id = o.prod_order_id
        LEFT JOIN trx_sales_order so2 ON so2.id = po.so_id
        LEFT JOIN cfg_sewing_line sl ON sl.id = o.line_id
        LEFT JOIN mst_unit un ON un.id = sl.unit_id
       WHERE o.company_id = ? AND COALESCE(o.status,'') NOT IN ('CANCELLED','DRAFT','REJECTED')${d3.w}`);
    params.push(cid, ...d3.p);
  }

  const where: string[] = []; const wp: unknown[] = [];
  if (q.buyer_id) { where.push('so.buyer_id = ?'); wp.push(q.buyer_id); }
  if (q.so_id) { where.push('so.id = ?'); wp.push(q.so_id); }
  if (q.season) { where.push('so.season = ?'); wp.push(q.season); }

  const rows = await query<any>(`
    SELECT u.src, u.doc_id, u.dc_id, u.doc_no, u.output_date, so.id AS so_id, COALESCE(so.so_no, u.job_key) AS sale_order, u.job_key AS io_no,
           st.style_code, COALESCE(st.description, st.style_name) AS style_description, b.party_name AS buyer_name,
           u.party, u.company_shift, ps.stage_name AS process,
           CASE WHEN u.dc_kind = 'FABRIC' OR ps.stage_code IN ('KNIT','DYE') THEN 'Fabric'
                WHEN ps.stage_code IN ('PRINT','EMB','WASH') THEN 'Value addition'
                WHEN ps.stage_code = 'CUT' THEN 'Cutting'
                WHEN ps.stage_code IN ('FINISH','IRON','CHECK','PACK') THEN 'Finishing'
                ELSE 'Sewing' END AS process_group,
           u.output_qty,
           ROUND(CASE ps.stage_code
             WHEN 'KNIT' THEN pc.knitting_cost WHEN 'DYE' THEN pc.dyeing_cost WHEN 'CUT' THEN pc.cutting_cost
             WHEN 'PRINT' THEN pc.printing_cost WHEN 'EMB' THEN pc.embroidery_cost WHEN 'STITCH' THEN pc.stitching_cost
             WHEN 'WASH' THEN pc.washing_cost WHEN 'PACK' THEN pc.packing_cost
             WHEN 'FINISH' THEN pc.finishing_cost WHEN 'IRON' THEN pc.finishing_cost WHEN 'CHECK' THEN pc.finishing_cost END
             , 4) AS budget_rate,  -- pre-costing heads are ₹ (client 16-Oct-2026)
           u.bill_rate, u.bill_amount, u.production_unit
      FROM (${parts.join(' UNION ALL ')}) u
      LEFT JOIN ${IOMAP} m ON m.company_id = ? AND m.k = u.job_key
      LEFT JOIN trx_sales_order so ON so.id = m.so_id
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN mst_style st ON st.id = u.style_id
      LEFT JOIN cfg_process_stage ps ON ps.id = u.stage_id
      LEFT JOIN ${APPROVED_COSTING} pc ON pc.style_id = u.style_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY u.output_date DESC, sale_order, process`,
    [...params, cid, cid, ...wp]);
  for (const r of rows) {
    r.budget_amount = r.budget_rate != null ? r2(n(r.budget_rate) * n(r.output_qty)) : null;
    r.bill_amount = r.bill_amount != null ? r2(n(r.bill_amount)) : null;
  }
  res.json({ data: rows, meta: { footnotes: [
    'Sources: process DC inwards (contractor and in-house unit DCs), sewing floor output, sewing daily output and daily output entries.',
    'Company shift = Yes for in-house work (line output, or a DC to an own unit). Bill rate / amount apply to contractor DC inwards only (inward rate, else the DC rate).',
    'Budget rate = the approved pre-costing head of the style for that process, per piece, in INR.',
  ] } });
}));

/* ================================================================ 5. Invoice made, despatch pending */
clientReportsARouter.get('/invoice-despatch-pending', VIEW, ah(async (req, res) => {
  const q = baseQ.parse(req.query);
  const cid = req.user!.companyId;
  const where = ['ci.company_id = ?', 'ci.dispatch_id IS NULL',
    `NOT EXISTS (SELECT 1 FROM trx_shipment sh WHERE sh.invoice_id = ci.id
                   AND (sh.dispatch_id IS NOT NULL OR sh.atd IS NOT NULL OR EXISTS (SELECT 1 FROM trx_dispatch d WHERE d.shipment_id = sh.id)))`];
  const params: unknown[] = [cid];
  if (q.buyer_id) { where.push('ci.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.so_id) { where.push('ci.so_id = ?'); params.push(q.so_id); }
  if (q.dateFrom) { where.push('ci.invoice_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo) { where.push('ci.invoice_date <= ?'); params.push(q.dateTo); }
  const rows = await query<any>(`
    SELECT ci.id AS invoice_id, COALESCE(b.party_name, sb.party_name) AS buyer_name, ci.invoice_no, ci.invoice_date,
           so.id AS so_id, so.so_no, st.style_code AS style_no,
           COALESCE(l.qty, 0) AS qty, l.unit_price AS price, COALESCE(l.amount, ci.total_value) AS amount,
           NULL AS hanger_amt, cur.code AS currency, ci.exchange_rate,
           ROUND(COALESCE(l.amount, ci.total_value) * COALESCE(ci.exchange_rate, CASE WHEN cur.code = 'INR' THEN 1 END), 2) AS value_inr,
           NULL AS hanger_value,
           ROUND(COALESCE(l.amount, ci.total_value) * COALESCE(ci.exchange_rate, CASE WHEN cur.code = 'INR' THEN 1 END), 2) AS total_inr,
           ci.port_of_loading AS ship_port, DATEDIFF(CURDATE(), ci.invoice_date) AS age
      FROM trx_commercial_invoice ci
      LEFT JOIN trx_commercial_invoice_line l ON l.invoice_id = ci.id
      LEFT JOIN trx_sales_order so ON so.id = ci.so_id
      LEFT JOIN mst_party b ON b.id = ci.buyer_id
      LEFT JOIN mst_party sb ON sb.id = so.buyer_id
      LEFT JOIN mst_style st ON st.id = l.style_id
      LEFT JOIN cfg_currency cur ON cur.id = ci.currency_id
     WHERE ${where.join(' AND ')}
     ORDER BY age DESC, ci.invoice_no, l.id`, params);
  res.json({ data: rows, meta: { footnotes: [
    'An invoice is despatch-pending while it has no despatch, and no shipment of it has a despatch or an actual departure date.',
    'Hanger Amt / Hanger Value are blank: commercial invoices do not carry a separate hanger charge in the ERP.',
  ] } });
}));

/* ================================================================ 6. Orders closed / cancelled during a period */
const closedQ = baseQ.extend({
  kind: z.enum(['closed', 'cancelled']).default('closed'),
  /** closed only: narrow to one closure type (migration 117). */
  closure: z.enum(['SHORT_CLOSED', 'COMPLETED']).optional(),
});

clientReportsARouter.get('/orders-closed', VIEW, ah(async (req, res) => {
  const q = closedQ.parse(req.query);
  const cid = req.user!.companyId;
  const cols = await soColumns();
  const has117 = cols.has('closure_type');
  const histStates = q.kind === 'closed' ? `('CLOSED','SHORT_CLOSED')` : `('CANCELLED')`;
  // Migration 117 closure fields (closure_type, closed_date, close_reason, closed_by, closed_at) lead;
  // orders closed before them fall back to the status-history entry, then the last update.
  const stateW = has117
    ? (q.kind === 'closed'
      ? `(so.closure_type IN ('SHORT_CLOSED','COMPLETED') OR (so.closure_type IS NULL AND so.approval_state IN ('CLOSED','SHORT_CLOSED')))`
      : `(so.closure_type = 'CANCELLED' OR (so.closure_type IS NULL AND so.approval_state = 'CANCELLED'))`)
    : `so.approval_state IN ${histStates}`;
  const dateCols = firstCol(cols, ['closed_date', 'closed_at']);
  const dateExpr = `DATE(COALESCE(${[...dateCols, 'hist.changed_at', 'so.updated_at'].join(', ')}))`;
  const reasonExpr = `COALESCE(${[...firstCol(cols, ['close_reason']), 'hist.remarks'].join(', ')})`;
  const byExpr = `COALESCE(${[...firstCol(cols, ['closed_by']), 'hist.changed_by'].join(', ')})`;
  const closureExpr = has117
    ? `COALESCE(so.closure_type, CASE so.approval_state WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'COMPLETED' END)`
    : `CASE so.approval_state WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'CLOSED' END`;
  const cancelledQty = cols.has('cancelled_qty') ? 'so.cancelled_qty' : '0';

  const where = ['so.company_id = ?', 'so.is_deleted = 0', stateW];
  const params: unknown[] = [cid];
  if (q.kind === 'closed' && q.closure) { where.push(`${closureExpr} = ?`); params.push(q.closure); }
  if (q.buyer_id) { where.push('so.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.season) { where.push('so.season = ?'); params.push(q.season); }
  if (q.dateFrom) { where.push(`${dateExpr} >= ?`); params.push(q.dateFrom); }
  if (q.dateTo) { where.push(`${dateExpr} <= ?`); params.push(q.dateTo); }

  const rows = await query<any>(`
    SELECT so.id AS so_id, b.party_name AS buyer_name, so.so_no, so.io_no, so.buyer_po_no, so.season, sty.styles AS style_no,
           so.so_date, COALESCE(so.delivery_date, so.ship_date) AS delivery_date, so.order_qty, ${cancelledQty} AS cancelled_qty,
           COALESCE(sh.qty,0) AS shipped_qty, GREATEST(so.order_qty - COALESCE(sh.qty,0), 0) AS unshipped_qty,
           cur.code AS currency, so.total_amount AS order_value,
           ROUND(GREATEST(so.order_qty - COALESCE(sh.qty,0), 0) * CASE WHEN so.order_qty > 0 THEN so.total_amount / so.order_qty ELSE 0 END, 2) AS unshipped_value,
           so.approval_state AS status, ${closureExpr} AS closure_type,
           ${dateExpr} AS action_date, ${reasonExpr} AS reason, u.full_name AS action_by
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
      LEFT JOIN ${SO_STYLES} sty ON sty.so_id = so.id
      LEFT JOIN ${SHIPPED} sh ON sh.so_id = so.id
      LEFT JOIN (SELECT h.record_id, h.changed_at, h.remarks, h.changed_by,
                        ROW_NUMBER() OVER (PARTITION BY h.record_id ORDER BY h.changed_at DESC, h.id DESC) AS rn
                   FROM trx_status_history h JOIN cfg_status cs ON cs.id = h.to_status_id
                  WHERE h.domain = 'SALES_ORDER' AND cs.code IN ${histStates}) hist ON hist.record_id = so.id AND hist.rn = 1
      LEFT JOIN mst_user u ON u.id = ${byExpr}
     WHERE ${where.join(' AND ')}
     ORDER BY action_date DESC, so.so_no`, [cid, ...params]);
  res.json({ data: rows, meta: { footnotes: [
    has117
      ? `${q.kind === 'closed' ? 'Closed (completed / short-closed)' : 'Cancelled'} orders by the order's closure type; date = its closed date (else the status-change history date, else the last update); reason and "by" from the closure entry.`
      : `${q.kind === 'closed' ? 'Closed' : 'Cancelled'} date = the status-change history date, else the order's last update.`,
  ] } });
}));

/* ================================================================ 7. Time & Action status */
const tnaQ = baseQ.extend({ health: z.enum(['delayed', 'pending', 'completed']).optional() });

clientReportsARouter.get('/tna-status', VIEW, ah(async (req, res) => {
  const q = tnaQ.parse(req.query);
  const cid = req.user!.companyId;
  const where = ['h.company_id = ?']; const params: unknown[] = [cid];
  if (q.buyer_id) { where.push('h.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.so_id) { where.push('h.sales_order_id = ?'); params.push(q.so_id); }
  if (q.dateFrom) { where.push('a.planned_end_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo) { where.push('a.planned_end_date <= ?'); params.push(q.dateTo); }
  if (q.health === 'completed') where.push(`(a.actual_end_date IS NOT NULL OR a.status = 'COMPLETED')`);
  if (q.health === 'pending') where.push(`a.actual_end_date IS NULL AND COALESCE(a.status,'') <> 'COMPLETED'`);
  if (q.health === 'delayed') where.push(`((a.actual_end_date IS NULL AND a.planned_end_date < CURDATE()) OR a.actual_end_date > a.planned_end_date)`);
  const rows = await query<any>(`
    SELECT h.id AS tna_id, h.tna_no, so.id AS so_id, so.so_no, b.party_name AS buyer_name, st.style_code AS style_no,
           h.order_qty, h.shipment_date, a.sequence_no, a.activity_name, a.category, a.department_name,
           u.full_name AS responsible, a.planned_start_date, a.planned_end_date, a.actual_start_date, a.actual_end_date,
           a.status,
           CASE WHEN a.actual_end_date IS NOT NULL THEN GREATEST(DATEDIFF(a.actual_end_date, a.planned_end_date), 0)
                WHEN a.planned_end_date < CURDATE() THEN DATEDIFF(CURDATE(), a.planned_end_date) ELSE 0 END AS delay_days,
           a.remarks
      FROM trx_tna_header h
      JOIN trx_tna_activity a ON a.tna_id = h.id
      LEFT JOIN trx_sales_order so ON so.id = h.sales_order_id
      LEFT JOIN mst_party b ON b.id = h.buyer_id
      LEFT JOIN mst_style st ON st.id = h.style_id
      LEFT JOIN mst_user u ON u.id = a.responsible_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY h.shipment_date, h.tna_no, a.sequence_no`, params);
  res.json({ data: rows, meta: { footnotes: ['Delay days: completed late = actual end − planned end; open and past due = today − planned end.'] } });
}));

/* ================================================================ 8. Despatches made, shipping bill pending */
clientReportsARouter.get('/despatch-sb-pending', VIEW, ah(async (req, res) => {
  const q = baseQ.parse(req.query);
  const cid = req.user!.companyId;
  const where = ['d.company_id = ?',
    `NOT EXISTS (SELECT 1 FROM trx_shipping_bill sb WHERE sb.company_id = d.company_id
                   AND (sb.id = sh.shipping_bill_id OR (ci.id IS NOT NULL AND sb.invoice_id = ci.id)))`];
  const params: unknown[] = [cid];
  if (q.buyer_id) { where.push('COALESCE(d.buyer_id, so.buyer_id) = ?'); params.push(q.buyer_id); }
  if (q.so_id) { where.push('so.id = ?'); params.push(q.so_id); }
  if (q.dateFrom) { where.push('d.dispatch_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo) { where.push('d.dispatch_date <= ?'); params.push(q.dateTo); }
  const rows = await query<any>(`
    SELECT d.id AS dispatch_id, d.dispatch_no, d.dispatch_date, b.party_name AS buyer_name,
           so.id AS so_id, so.so_no, COALESCE(d.io_no, so.io_no) AS io_no,
           sh.id AS shipment_id, sh.shipment_no, ci.id AS invoice_id, ci.invoice_no, d.mode, d.vehicle_no,
           d.total_cartons, d.total_qty, sh.pol AS port, DATEDIFF(CURDATE(), d.dispatch_date) AS age
      FROM trx_dispatch d
      LEFT JOIN trx_shipment sh ON sh.id = COALESCE(d.shipment_id, (SELECT s2.id FROM trx_shipment s2 WHERE s2.dispatch_id = d.id LIMIT 1))
      LEFT JOIN trx_commercial_invoice ci ON ci.id = COALESCE(sh.invoice_id, (SELECT c2.id FROM trx_commercial_invoice c2 WHERE c2.dispatch_id = d.id LIMIT 1))
      LEFT JOIN trx_sales_order so ON so.id = COALESCE(d.so_id, sh.so_id, ci.so_id)
      LEFT JOIN mst_party b ON b.id = COALESCE(d.buyer_id, so.buyer_id)
     WHERE ${where.join(' AND ')}
     ORDER BY age DESC, d.dispatch_no`, params);
  res.json({ data: rows, meta: { footnotes: [
    'A despatch is shipping-bill pending while neither its shipment nor its commercial invoice has a shipping bill entry.',
  ] } });
}));

/* ================================================================ 9. Master chart — exports */
clientReportsARouter.get('/master-chart-exports', VIEW, ah(async (req, res) => {
  const q = baseQ.parse(req.query);
  const cid = req.user!.companyId;
  const where = ['ci.company_id = ?']; const params: unknown[] = [cid];
  if (q.buyer_id) { where.push('ci.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.so_id) { where.push('ci.so_id = ?'); params.push(q.so_id); }
  if (q.season) { where.push('so.season = ?'); params.push(q.season); }
  if (q.dateFrom) { where.push('ci.invoice_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo) { where.push('ci.invoice_date <= ?'); params.push(q.dateTo); }
  const rows = await query<any>(`
    SELECT ci.id AS invoice_id, ci.invoice_no, ci.invoice_date, b.party_name AS buyer_name,
           so.id AS so_id, so.so_no, so.buyer_po_no, so.season, il.styles AS style_no, COALESCE(il.qty,0) AS qty,
           cur.code AS currency, ci.incoterm, ci.fob_value, ci.freight_value, ci.insurance_value, ci.total_value,
           ci.exchange_rate, ROUND(ci.total_value * COALESCE(ci.exchange_rate, CASE WHEN cur.code = 'INR' THEN 1 END), 2) AS value_inr,
           ci.port_of_loading, ci.port_of_discharge, ci.final_destination, ci.lc_no,
           sh.id AS shipment_id, sh.shipment_no, sh.mode, sh.vessel_name, sh.bl_no, sh.bl_date, sh.etd, sh.eta,
           sb.id AS shipping_bill_id, sb.sb_no, sb.sb_date, sb.leo_date, sb.drawback_amount, sb.rodtep_amount,
           ist.label AS invoice_status
      FROM trx_commercial_invoice ci
      LEFT JOIN (SELECT l.invoice_id, SUM(l.qty) AS qty,
                        GROUP_CONCAT(DISTINCT st.style_code ORDER BY st.style_code SEPARATOR ', ') AS styles
                   FROM trx_commercial_invoice_line l LEFT JOIN mst_style st ON st.id = l.style_id
                  GROUP BY l.invoice_id) il ON il.invoice_id = ci.id
      LEFT JOIN trx_sales_order so ON so.id = ci.so_id
      LEFT JOIN mst_party b ON b.id = COALESCE(ci.buyer_id, so.buyer_id)
      LEFT JOIN cfg_currency cur ON cur.id = ci.currency_id
      LEFT JOIN (SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.invoice_id ORDER BY s.id DESC) AS rn
                   FROM trx_shipment s WHERE s.company_id = ? AND s.invoice_id IS NOT NULL) sh ON sh.invoice_id = ci.id AND sh.rn = 1
      LEFT JOIN (SELECT x.*, ROW_NUMBER() OVER (PARTITION BY x.invoice_id ORDER BY x.id DESC) AS rn
                   FROM trx_shipping_bill x WHERE x.company_id = ?) sb ON sb.invoice_id = ci.id AND sb.rn = 1
      LEFT JOIN cfg_status ist ON ist.id = ci.status_id
     WHERE ${where.join(' AND ')}
     ORDER BY ci.invoice_date DESC, ci.invoice_no`, [cid, cid, ...params]);
  res.json({ data: rows, meta: { footnotes: ['One row per commercial invoice, with its latest shipment and shipping bill.'] } });
}));
