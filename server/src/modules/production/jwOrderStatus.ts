/**
 * Job work order status and balances (job work doc §6, §10, §23), shared by the DC engine and the order routes.
 *   Ordered / Outward / Received / Reject / Loss / Returned / Contractor balance / Pending outward — per route line.
 * Status follows the DCs: APPROVED → PARTIAL_OUTWARD → IN_PROCESS → PARTIAL_INWARD → COMPLETED (DRAFT / CLOSED /
 * CANCELLED are set by hand only).
 */
import { txQuery, txQueryOne, txExecute, query, type Tx } from '../../config/db.js';

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function orderLineBalances(tx: Tx | null, orderId: number) {
  const sql = `SELECT l.*, ps.stage_name, ps.stage_code,
        COALESCE((SELECT SUM(jc.total_qty) FROM trx_jobwork_challan jc WHERE jc.jw_order_line_id = l.id AND jc.status NOT IN ('CANCELLED','DRAFT') AND jc.dc_kind = 'BUNDLE'), 0) AS outward_pcs,
        COALESCE((SELECT SUM(fi.issue_kg) FROM trx_jw_fabric_issue fi JOIN trx_jobwork_challan jc ON jc.id = fi.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS outward_kg,
        COALESCE((SELECT SUM(jl.received_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS good_pcs,
        COALESCE((SELECT SUM(jl.rejected_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS reject_pcs,
        COALESCE((SELECT SUM(jl.shortage_qty + jl.loss_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS loss_pcs,
        COALESCE((SELECT SUM(jl.returned_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS returned_pcs,
        COALESCE((SELECT SUM(jl.rework_open_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS rework_open_pcs,
        COALESCE((SELECT SUM(jl.qty - jl.received_qty - jl.rejected_qty - jl.shortage_qty - jl.loss_qty - jl.returned_qty) FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
                   WHERE jc.jw_order_line_id = l.id AND jc.status IN ('ISSUED','PARTIAL_RECEIVED')), 0) AS contractor_pcs,
        COALESCE((SELECT SUM(fi.issue_kg - fi.consumed_kg - fi.returned_kg - fi.waste_kg) FROM trx_jw_fabric_issue fi JOIN trx_jobwork_challan jc ON jc.id = fi.challan_id
                   WHERE jc.jw_order_line_id = l.id AND jc.status <> 'CANCELLED'), 0) AS contractor_kg
     FROM trx_jw_order_line l LEFT JOIN cfg_process_stage ps ON ps.id = l.stage_id WHERE l.order_id = ? ORDER BY l.seq_no, l.id`;
  const rows = tx ? await txQuery<any>(tx, sql, [orderId]) : await query<any>(sql, [orderId]);
  return rows.map((l) => {
    const fabric = l.input_kind === 'FABRIC';
    const outward = fabric ? n(l.outward_kg) : n(l.outward_pcs);
    return {
      ...l, outward, planned: n(l.planned_input_qty), pending_outward: Math.max(0, n(l.planned_input_qty) - outward),
      good: n(l.good_pcs), reject: n(l.reject_pcs), loss: n(l.loss_pcs), returned: n(l.returned_pcs), rework_open: n(l.rework_open_pcs),
      contractor_balance: fabric ? Math.round(n(l.contractor_kg) * 1000) / 1000 : n(l.contractor_pcs), contractor_pcs: n(l.contractor_pcs),
      contractor_kg: Math.round(n(l.contractor_kg) * 1000) / 1000, balance_uom: fabric ? 'KG' : 'PCS',
    };
  });
}

export async function refreshJwOrder(tx: Tx, orderId: number | null | undefined) {
  if (!orderId) return null;
  const o = await txQueryOne<any>(tx, `SELECT id, status FROM trx_jw_order WHERE id = ? FOR UPDATE`, [orderId]);
  if (!o || ['DRAFT', 'CLOSED', 'CANCELLED'].includes(o.status)) return o?.status ?? null;
  const lines = await orderLineBalances(tx, orderId);
  const outward = lines.reduce((a, l) => a + l.outward, 0);
  const received = lines.reduce((a, l) => a + l.good + l.reject, 0);
  const atContractor = lines.reduce((a, l) => a + l.contractor_pcs + l.contractor_kg, 0);
  const allOut = lines.every((l) => l.pending_outward <= 0.0005);
  let status = 'APPROVED';
  if (outward > 0) {
    if (atContractor > 0.0005) status = received > 0 ? 'PARTIAL_INWARD' : (allOut ? 'IN_PROCESS' : 'PARTIAL_OUTWARD');
    else status = allOut ? 'COMPLETED' : 'PARTIAL_OUTWARD';
  }
  if (status !== o.status) await txExecute(tx, `UPDATE trx_jw_order SET status = ? WHERE id = ?`, [status, orderId]);
  return status;
}

/**
 * Process rate (job work doc §17): contractor + process + style + buyer + UOM, falling back to contractor + process +
 * UOM; the most specific active row valid on the date wins.
 */
export async function resolveJwRate(cid: number, p: { vendor_id: number; stage_id: number; style_id?: number | null; buyer_id?: number | null; uom?: string; on?: string | null }) {
  const rows = await query<any>(
    `SELECT * FROM mst_jw_rate WHERE company_id = ? AND vendor_id = ? AND stage_id = ? AND is_active = 1 AND uom = ?
        AND (effective_from IS NULL OR effective_from <= COALESCE(?, CURDATE())) AND (effective_to IS NULL OR effective_to >= COALESCE(?, CURDATE()))
        AND (style_id IS NULL OR style_id = ?) AND (buyer_id IS NULL OR buyer_id = ?)
      ORDER BY (style_id IS NOT NULL) DESC, (buyer_id IS NOT NULL) DESC, effective_from DESC, id DESC LIMIT 1`,
    [cid, p.vendor_id, p.stage_id, p.uom ?? 'PCS', p.on ?? null, p.on ?? null, p.style_id ?? 0, p.buyer_id ?? 0]);
  return rows[0] ? { rate: n(rows[0].rate), rate_id: Number(rows[0].id), basis: rows[0].style_id ? 'STYLE' : rows[0].buyer_id ? 'BUYER' : 'CONTRACTOR' } : null;
}

/** Tolerance % for reject + shortage + loss on a DC: order line → process → company setting. */
export async function lossTolerance(tx: Tx, cid: number, dc: any) {
  if (dc.jw_order_line_id) {
    const l = await txQueryOne<any>(tx, `SELECT loss_tolerance_pct FROM trx_jw_order_line WHERE id = ?`, [dc.jw_order_line_id]);
    if (l?.loss_tolerance_pct != null) return n(l.loss_tolerance_pct);
  }
  const st = await txQueryOne<any>(tx, `SELECT loss_tolerance_pct FROM cfg_process_stage WHERE id = ?`, [dc.stage_id]);
  if (st?.loss_tolerance_pct != null) return n(st.loss_tolerance_pct);
  const s = await txQueryOne<any>(tx, `SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'JW_LOSS_TOLERANCE_PCT'`, [cid]);
  const v = Number(s?.v);
  return Number.isFinite(v) ? v : 2;
}
