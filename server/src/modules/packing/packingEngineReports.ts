import { Router } from 'express';
import { query, queryOne, transaction } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { bundleAvail, packingRequiresQc } from '../production/bundleLedger.js';

/**
 * Packing reports (doc §18) — GET /api/packing/reports/:key
 *   job-status · po-status · balance · carton-register · carton-contents · consumption · packaging-stock
 *   full-partial · pending · packed-vs-dispatched · reconciliation · repack-history · trace?code=
 * Optional filters: so_id, from, to (carton created date).
 * The buyer packing list itself is the packing-list screen (/logistics/packing-lists).
 */
export const packingReportsRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const DISPATCHED_SQL = `(c.carton_status = 'DISPATCHED' OR EXISTS (SELECT 1 FROM trx_shipment_package sp WHERE sp.carton_id = c.id AND sp.status IN ('DISPATCHED','DELIVERED')))`;

export const REPORTS = [
  { key: 'job-status', label: 'Job-wise packing status' },
  { key: 'po-status', label: 'PO-wise packing status' },
  { key: 'balance', label: 'Style / colour / size balance' },
  { key: 'carton-register', label: 'Carton register' },
  { key: 'carton-contents', label: 'Carton contents' },
  { key: 'consumption', label: 'Polybag & carton consumption' },
  { key: 'packaging-stock', label: 'Packaging stock & variance' },
  { key: 'full-partial', label: 'Full vs partial cartons' },
  { key: 'pending', label: 'Unsealed / verification pending' },
  { key: 'packed-vs-dispatched', label: 'Packed vs dispatched' },
  { key: 'reconciliation', label: 'Packing reconciliation' },
  { key: 'repack-history', label: 'Repack / reopen / void history' },
  { key: 'trace', label: 'Carton barcode traceability' },
];

packingReportsRouter.get('/reports', requirePermission('PACKING.VIEW'), ah(async (_req, res) => { res.json({ data: REPORTS }); }));

packingReportsRouter.get('/reports/:key', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const so = req.query.so_id ? Number(req.query.so_id) : null;
  const from = req.query.from ? String(req.query.from) : null; const to = req.query.to ? String(req.query.to) : null;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) throw BadRequest('Dates must be YYYY-MM-DD');
  const pf = `${so ? ' AND p.so_id = ' + Number(so) : ''}`;
  const cf = `${from ? ' AND DATE(c.created_at) >= ' + JSON.stringify(from).replace(/"/g, "'") : ''}${to ? ' AND DATE(c.created_at) <= ' + JSON.stringify(to).replace(/"/g, "'") : ''}`;
  let rows: any[] = [];

  switch (req.params.key) {
    case 'job-status':
    case 'po-status': {
      const byPo = req.params.key === 'po-status';
      rows = await query(
        `SELECT ${byPo ? "so.id so_id, so.so_no, so.buyer_po_no, b.party_name buyer_name" : "p.io_no job_no, st.style_code, so.buyer_po_no"},
                COUNT(DISTINCT p.id) orders, SUM(p.planned_qty) planned_qty,
                (SELECT COALESCE(SUM(c.pieces_total),0) FROM trx_carton c JOIN trx_packing p2 ON p2.id = c.packing_id
                  WHERE p2.is_engine = 1 AND c.is_posted = 1 AND c.carton_status <> 'VOID' AND ${byPo ? 'p2.so_id = so.id' : 'p2.io_no = p.io_no AND p2.style_id = p.style_id'}) packed_qty,
                (SELECT COALESCE(SUM(c.pieces_total),0) FROM trx_carton c JOIN trx_packing p2 ON p2.id = c.packing_id
                  WHERE p2.is_engine = 1 AND c.is_posted = 0 AND c.carton_status <> 'VOID' AND ${byPo ? 'p2.so_id = so.id' : 'p2.io_no = p.io_no AND p2.style_id = p.style_id'}) unposted_qty,
                (SELECT COUNT(*) FROM trx_carton c JOIN trx_packing p2 ON p2.id = c.packing_id
                  WHERE p2.is_engine = 1 AND c.is_posted = 1 AND c.carton_status <> 'VOID' AND ${byPo ? 'p2.so_id = so.id' : 'p2.io_no = p.io_no AND p2.style_id = p.style_id'}) cartons,
                GROUP_CONCAT(DISTINCT p.order_status) statuses
           FROM trx_packing p JOIN trx_sales_order so ON so.id = p.so_id LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN mst_party b ON b.id = so.buyer_id
          WHERE p.company_id = ? AND p.is_engine = 1 AND p.order_status <> 'CANCELLED' ${pf}
          GROUP BY ${byPo ? 'so.id, so.so_no, so.buyer_po_no, b.party_name' : 'p.io_no, p.style_id, st.style_code, so.buyer_po_no'} ORDER BY 1 DESC`, [cid]);
      rows = rows.map((r) => ({ ...r, balance_qty: Math.max(n(r.planned_qty) - n(r.packed_qty), 0), pct_packed: n(r.planned_qty) ? Math.round((n(r.packed_qty) / n(r.planned_qty)) * 1000) / 10 : 0 }));
      break;
    }
    case 'balance': {
      const strict = await transaction((tx) => packingRequiresQc(tx, cid));
      const bundles = await query<any>(
        `SELECT cb.*, st.style_code, col.color_name, sz.size_code, sz.sort_order FROM trx_cutting_bundle cb
           LEFT JOIN trx_cutting c ON c.id = cb.cutting_id LEFT JOIN mst_style st ON st.id = cb.style_id
           LEFT JOIN mst_color col ON col.id = cb.color_id LEFT JOIN mst_size sz ON sz.id = cb.size_id
          WHERE COALESCE(cb.company_id, c.company_id) = ? AND cb.status NOT IN ('SPLIT','CANCELLED')
            AND cb.io_no IN (SELECT p.io_no FROM trx_packing p WHERE p.company_id = ? AND p.is_engine = 1 ${pf})`, [cid, cid]);
      const m = new Map<string, any>();
      for (const b of bundles) {
        const k = `${b.io_no}|${b.style_id}|${b.color_id}|${b.size_id}`;
        const a = bundleAvail(b, strict);
        const r = m.get(k) ?? { job_no: b.io_no, style_code: b.style_code, color_name: b.color_name, size_code: b.size_code, sort_order: n(b.sort_order), finished: 0, ready_to_pack: 0, qc_pending: 0, packed: 0 };
        r.finished += n(b.fin_good_qty); r.ready_to_pack += a.pack; r.qc_pending += strict ? a.qc : 0; r.packed += a.packed;
        m.set(k, r);
      }
      rows = [...m.values()].sort((a, b) => `${a.job_no}${a.style_code}${a.color_name}`.localeCompare(`${b.job_no}${b.style_code}${b.color_name}`) || a.sort_order - b.sort_order);
      break;
    }
    case 'carton-register':
      rows = await query(
        `SELECT c.id, c.carton_no, c.carton_seq, p.pack_no, p.io_no job_no, st.style_code, so.buyer_po_no, c.carton_status, c.is_posted, c.posted_at,
                c.pieces_total, c.polybag_qty, c.std_polybag_qty, c.is_partial, c.net_weight_kg, c.gross_weight_kg, c.cbm, c.seal_no, ct.trim_name carton_type, c.created_at,
                ${DISPATCHED_SQL} dispatched
           FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id JOIN trx_sales_order so ON so.id = p.so_id
           LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN mst_trim ct ON ct.id = c.carton_trim_id
          WHERE p.company_id = ? AND p.is_engine = 1 ${pf} ${cf} ORDER BY c.id DESC LIMIT 2000`, [cid]);
      break;
    case 'carton-contents':
      rows = await query(
        `SELECT c.carton_no, p.pack_no, p.io_no job_no, st.style_code, col.color_name, sz.size_code, cc.qty, cc.polybag_qty, c.carton_status, c.is_posted
           FROM trx_carton_content cc JOIN trx_carton c ON c.id = cc.carton_id JOIN trx_packing p ON p.id = c.packing_id
           LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN mst_color col ON col.id = cc.color_id LEFT JOIN mst_size sz ON sz.id = cc.size_id
          WHERE p.company_id = ? AND p.is_engine = 1 AND c.carton_status <> 'VOID' ${pf} ${cf} ORDER BY c.id DESC, col.color_name, sz.sort_order LIMIT 5000`, [cid]);
      break;
    case 'consumption':
      rows = await query(
        `SELECT p.pack_no, p.io_no job_no, pc.material_kind, t.trim_code, t.trim_name, COUNT(DISTINCT pc.carton_id) cartons,
                SUM(CASE WHEN pc.reversed_at IS NULL THEN pc.qty ELSE 0 END) consumed_qty,
                SUM(CASE WHEN pc.reversed_at IS NOT NULL THEN pc.qty ELSE 0 END) reversed_qty
           FROM trx_packing_consumption pc JOIN trx_packing p ON p.id = pc.packing_id JOIN mst_trim t ON t.id = pc.trim_id JOIN trx_carton c ON c.id = pc.carton_id
          WHERE pc.company_id = ? ${pf} ${cf} GROUP BY p.pack_no, p.io_no, pc.material_kind, t.trim_code, t.trim_name ORDER BY p.pack_no DESC`, [cid]);
      break;
    case 'packaging-stock':
      rows = await query(
        `SELECT t.id, t.trim_type, t.trim_code, t.trim_name,
                COALESCE((SELECT SUM(ts.stock_qty) FROM trx_trim_stock ts WHERE ts.trim_id = t.id AND ts.company_id = t.company_id),0) stock_qty,
                COALESCE((SELECT SUM(pc.qty) FROM trx_packing_consumption pc WHERE pc.trim_id = t.id AND pc.reversed_at IS NULL),0) consumed_qty,
                COALESCE((SELECT SUM(CASE WHEN pc.material_kind = 'CARTON' THEN 1 ELSE c.std_polybag_qty END)
                            FROM (SELECT DISTINCT carton_id, material_kind FROM trx_packing_consumption WHERE trim_id = t.id AND reversed_at IS NULL) pc
                            JOIN trx_carton c ON c.id = pc.carton_id),0) standard_qty
           FROM mst_trim t WHERE t.company_id = ? AND t.trim_type IN ('POLYBAG','CARTON') AND t.is_deleted = 0 ORDER BY t.trim_type, t.trim_name`, [cid]);
      rows = rows.map((r) => ({ ...r, variance_qty: n(r.consumed_qty) - n(r.standard_qty), negative: n(r.stock_qty) < 0 ? 1 : 0 }));
      break;
    case 'full-partial':
      rows = await query(
        `SELECT p.pack_no, p.io_no job_no, st.style_code, SUM(c.is_partial = 0) full_cartons, SUM(c.is_partial = 1) partial_cartons, COUNT(*) cartons,
                SUM(c.pieces_total) pieces
           FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id LEFT JOIN mst_style st ON st.id = p.style_id
          WHERE p.company_id = ? AND p.is_engine = 1 AND c.carton_status <> 'VOID' ${pf} ${cf} GROUP BY p.id, p.pack_no, p.io_no, st.style_code ORDER BY p.id DESC`, [cid]);
      break;
    case 'pending':
      rows = await query(
        `SELECT c.id, c.carton_no, p.pack_no, p.io_no job_no, st.style_code, c.carton_status, c.is_posted, c.pieces_total, c.created_at,
                CASE WHEN c.carton_status IN ('DRAFT','OPEN') THEN 'Verification pending'
                     WHEN c.carton_status = 'VERIFIED' THEN 'Not sealed'
                     ELSE 'Not posted' END pending_reason
           FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id LEFT JOIN mst_style st ON st.id = p.style_id
          WHERE p.company_id = ? AND p.is_engine = 1 AND (c.carton_status IN ('DRAFT','OPEN','VERIFIED') OR (c.carton_status = 'SEALED' AND c.is_posted = 0)) ${pf} ${cf}
          ORDER BY c.created_at`, [cid]);
      break;
    case 'packed-vs-dispatched':
      rows = await query(
        `SELECT p.pack_no, p.io_no job_no, st.style_code, so.buyer_po_no, p.planned_qty,
                SUM(CASE WHEN c.is_posted = 1 AND c.carton_status <> 'VOID' THEN c.pieces_total ELSE 0 END) packed_qty,
                SUM(CASE WHEN c.is_posted = 1 AND c.carton_status <> 'VOID' AND ${DISPATCHED_SQL} THEN c.pieces_total ELSE 0 END) dispatched_qty,
                SUM(c.is_posted = 1 AND c.carton_status <> 'VOID') packed_cartons,
                SUM(c.is_posted = 1 AND c.carton_status <> 'VOID' AND ${DISPATCHED_SQL}) dispatched_cartons
           FROM trx_packing p JOIN trx_sales_order so ON so.id = p.so_id LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN trx_carton c ON c.packing_id = p.id
          WHERE p.company_id = ? AND p.is_engine = 1 ${pf} GROUP BY p.id, p.pack_no, p.io_no, st.style_code, so.buyer_po_no, p.planned_qty ORDER BY p.id DESC`, [cid]);
      rows = rows.map((r) => ({ ...r, pending_dispatch_qty: n(r.packed_qty) - n(r.dispatched_qty) }));
      break;
    case 'reconciliation':
      rows = await query(
        `SELECT p.id, p.pack_no, p.io_no job_no, st.style_code, p.order_status, p.planned_qty, p.planned_polybags, p.planned_cartons,
                COALESCE(SUM(CASE WHEN c.is_posted = 1 AND c.carton_status <> 'VOID' THEN c.pieces_total END),0) packed_qty,
                COALESCE(SUM(CASE WHEN c.is_posted = 1 AND c.carton_status <> 'VOID' THEN c.polybag_qty END),0) polybags_actual,
                COALESCE(SUM(CASE WHEN c.is_posted = 1 AND c.carton_status <> 'VOID' THEN c.std_polybag_qty END),0) polybags_expected,
                COALESCE(SUM(c.is_posted = 1 AND c.carton_status <> 'VOID'),0) cartons_actual,
                COALESCE(SUM(c.is_posted = 0 AND c.carton_status <> 'VOID'),0) cartons_unposted,
                p.variance_approved_at, p.variance_note
           FROM trx_packing p LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN trx_carton c ON c.packing_id = p.id
          WHERE p.company_id = ? AND p.is_engine = 1 ${pf} GROUP BY p.id ORDER BY p.id DESC`, [cid]);
      rows = rows.map((r) => ({ ...r, balance_qty: Math.max(n(r.planned_qty) - n(r.packed_qty), 0), polybag_variance: n(r.polybags_actual) - n(r.polybags_expected) }));
      break;
    case 'repack-history':
      rows = await query(
        `SELECT e.created_at, e.event_type, e.from_status, e.to_status, e.reason, c.carton_no, p.pack_no, p.io_no job_no, u.full_name by_user
           FROM trx_carton_event e JOIN trx_carton c ON c.id = e.carton_id JOIN trx_packing p ON p.id = e.packing_id LEFT JOIN mst_user u ON u.id = e.created_by
          WHERE e.company_id = ? AND e.event_type IN ('REOPEN','VOID','REVERSE') ${pf} ORDER BY e.id DESC LIMIT 2000`, [cid]);
      break;
    case 'trace': {
      const code = String(req.query.code ?? '').trim();
      if (!code) throw BadRequest('Scan or type a carton barcode');
      const c = await queryOne<any>(
        `SELECT c.*, p.pack_no, p.io_no job_no, so.so_no, so.buyer_po_no, st.style_code, b.party_name buyer_name
           FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id JOIN trx_sales_order so ON so.id = p.so_id
           LEFT JOIN mst_style st ON st.id = p.style_id LEFT JOIN mst_party b ON b.id = so.buyer_id
          WHERE p.company_id = ? AND (c.barcode = ? OR c.carton_no = ?) ORDER BY (c.barcode = ?) DESC LIMIT 1`, [cid, code, code, code]);
      if (!c) throw NotFound(`No carton with barcode ${code}`);
      const contents = await query(
        `SELECT col.color_name, sz.size_code, cc.qty, cc.polybag_qty FROM trx_carton_content cc LEFT JOIN mst_color col ON col.id = cc.color_id
           LEFT JOIN mst_size sz ON sz.id = cc.size_id WHERE cc.carton_id = ? ORDER BY col.color_name, sz.sort_order`, [c.id]);
      const bundles = await query(
        `SELECT cb.bundle_no, cb.barcode, ctb.qty, col.color_name, sz.size_code, cut.cut_no, cb.status
           FROM trx_carton_bundle ctb JOIN trx_cutting_bundle cb ON cb.id = ctb.bundle_id LEFT JOIN trx_cutting cut ON cut.id = cb.cutting_id
           LEFT JOIN mst_color col ON col.id = cb.color_id LEFT JOIN mst_size sz ON sz.id = cb.size_id WHERE ctb.carton_id = ? ORDER BY cb.bundle_no`, [c.id]);
      const events = await query(`SELECT event_type, from_status, to_status, reason, created_at FROM trx_carton_event WHERE carton_id = ? ORDER BY id`, [c.id]);
      const shipment = await query(
        `SELECT sh.shipment_no, sp.status FROM trx_shipment_package sp JOIN trx_shipment sh ON sh.id = sp.shipment_id WHERE sp.carton_id = ?`, [c.id]);
      res.json({ data: { carton: c, contents, bundles, events, shipment } });
      return;
    }
    default:
      throw NotFound('Unknown packing report');
  }
  // SUM() comes back as a decimal string — hand numbers to the screens
  const NUMERIC = /^(planned|packed|unposted|cartons|orders|finished|ready|qc|stock|consumed|reversed|standard|variance|full|partial|pieces|dispatched|pending|polybags|balance|net|gross|cbm)/;
  rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && NUMERIC.test(k) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
  res.json({ data: rows });
}));
