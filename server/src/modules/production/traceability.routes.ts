import { Router } from 'express';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

export const traceabilityRouter = Router();

/**
 * GET /production/io/:ioNo/styles
 * Returns all styles, order quantities, and variants under a specific I/O No.
 */
traceabilityRouter.get('/production/io/:ioNo/styles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const ioNo = req.params.ioNo;

  // Check across production orders and sales orders for this IO
  const styles = await query(
    `SELECT DISTINCT
            st.id AS style_id, st.style_code, st.style_name,
            so.id AS so_id, so.so_no,
            po.id AS prod_order_id, po.po_prod_no,
            SUM(so.order_qty) AS total_order_qty
       FROM trx_sales_order so
       LEFT JOIN trx_production_order po ON po.so_id = so.id
       LEFT JOIN mst_style st ON st.id = so.style_id OR st.id = po.style_id
      WHERE (po.io_no = ? OR so.po_no = ? OR so.so_no = ?) AND so.company_id = ?
      GROUP BY st.id, st.style_code, st.style_name, so.id, so.so_no, po.id, po.po_prod_no`,
    [ioNo, ioNo, ioNo, cid]);

  res.json({ data: styles });
}));

/**
 * GET /io/:ioNo/traceability
 * Comprehensive end-to-end forward/backward audit tree for an I/O No.
 */
traceabilityRouter.get('/io/:ioNo/traceability', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const ioNo = req.params.ioNo;

  const [
    salesOrders,
    prodOrders,
    cuttingPlans,
    fabricIssues,
    layPlans,
    cuttings,
    cutQcs,
    bundles,
    sewingInputs,
    sewingOutputs,
    finishingOutputs,
    finalQcs,
    fgReceipts,
    packings,
    packingLists,
    shipments,
    dispatches,
    knittingOrders,
    fabricProcessOrders,
    trimPos,
    trimGrns,
  ] = await Promise.all([
    query(`SELECT id, so_no, so_date, order_qty, buyer_id FROM trx_sales_order WHERE (so_no = ? OR po_no = ?) AND company_id = ?`, [ioNo, ioNo, cid]),
    query(`SELECT id, po_prod_no, prod_date, order_qty, planned_qty FROM trx_production_order WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, plan_no, plan_date, style_id, color_id, order_qty, planned_cut_qty, actual_cut_qty, status FROM trx_cutting_plan WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, issue_no, issue_date, total_rolls, total_mtr, total_kg, status FROM trx_fabric_issue WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, lay_no, lay_date, marker_ref, ply_count, planned_cut_qty, status FROM trx_lay_plan WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, cut_no, cut_date, total_pieces, marker_ref, ply_count FROM trx_cutting WHERE io_no = ?`, [ioNo]),
    query(`SELECT id, qc_no, qc_date, component, cut_qty, accepted_qty, reject_qty, recut_qty, qc_status FROM trx_cut_piece_qc WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, bundle_no, barcode, qty, status FROM trx_cutting_bundle WHERE io_no = ?`, [ioNo]),
    query(`SELECT id, input_no, input_date, line_name, input_qty, status FROM trx_sewing_input WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, output_no, output_date, line_name, output_qty, reject_qty, rework_qty FROM trx_sewing_output WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, output_no, output_date, output_qty, reject_qty, rework_qty FROM trx_finishing_output WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, qc_no, qc_date, inspected_qty, passed_qty, reject_qty, qc_status FROM trx_final_qc WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, receipt_no, receipt_date, total_qty, total_reject, status FROM trx_fg_receipt WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, pack_no, pack_date, total_cartons, total_qty, net_weight_kg, gross_weight_kg FROM trx_packing WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, pl_no, pl_date, shipment_type, total_cartons, total_qty, status FROM trx_packing_list WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, shipment_no, shipment_type, mode, total_packages, total_qty, destination FROM trx_shipment WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, dispatch_no, dispatch_date, vehicle_no, lr_no, eway_bill_no, total_cartons, total_qty FROM trx_dispatch WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, kwo_no, kwo_date, sub_process, planned_fabric_kg, status FROM trx_knitting_order WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, fpo_no, fpo_date, sub_process, color_name, input_weight_kg, output_weight_kg, status FROM trx_fabric_process_order WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, po_no, po_date, grand_total, status FROM trx_trim_po WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, grn_no, grn_date, status FROM trx_trim_grn WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
  ]);

  res.json({
    data: {
      ioNo,
      salesOrders,
      prodOrders,
      cuttingPlans,
      fabricIssues,
      layPlans,
      cuttings,
      cutQcs,
      bundles,
      sewingInputs,
      sewingOutputs,
      finishingOutputs,
      finalQcs,
      fgReceipts,
      packings,
      packingLists,
      shipments,
      dispatches,
      knittingOrders,
      fabricProcessOrders,
      trimPos,
      trimGrns,
    }
  });
}));

/**
 * GET /style/:styleNo/production-history
 * Style-centric production and shipment history.
 */
traceabilityRouter.get('/style/:styleNo/production-history', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const styleNo = req.params.styleNo;

  const style = await queryOne<any>(
    `SELECT * FROM mst_style WHERE (style_code = ? OR id = ?) AND company_id = ?`, [styleNo, Number(styleNo) || 0, cid]);
  if (!style) throw NotFound('Style not found');

  const [orders, cuttingPlans, cutSummary, fgSummary, packedSummary, shippedSummary] = await Promise.all([
    query(`SELECT so.so_no, so.so_date, so.order_qty, po.po_prod_no, po.io_no
             FROM trx_sales_order so
             LEFT JOIN trx_production_order po ON po.so_id = so.id
            WHERE so.style_id = ? AND so.company_id = ?`, [style.id, cid]),
    query(`SELECT cp.plan_no, cp.io_no, cp.planned_cut_qty, cp.actual_cut_qty, cp.status
             FROM trx_cutting_plan cp
            WHERE cp.style_id = ? AND cp.company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(actual_cut_qty),0) AS total_cut FROM trx_cutting_plan WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(total_qty),0) AS total_fg FROM trx_fg_receipt WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(total_qty),0) AS total_packed FROM trx_packing WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(total_qty),0) AS total_shipped FROM trx_shipment WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
  ]);

  res.json({
    data: {
      style,
      orders,
      cuttingPlans,
      summary: {
        total_cut: cutSummary?.total_cut || 0,
        total_fg: fgSummary?.total_fg || 0,
        total_packed: packedSummary?.total_packed || 0,
        total_shipped: shippedSummary?.total_shipped || 0,
      }
    }
  });
}));

/**
 * GET /traceability/search?q=...
 * Search across I/O No, Style No, Bundle No, Carton No, Roll No.
 */
traceabilityRouter.get('/traceability/search', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: [] });

  const results: any[] = [];

  // 1. Search I/O No in cutting plans or prod orders
  const ios = await query(
    `SELECT DISTINCT io_no FROM trx_cutting_plan WHERE io_no LIKE ? AND company_id = ? LIMIT 5`, [`%${q}%`, cid]);
  for (const row of ios as any[]) {
    results.push({ type: 'I/O', key: row.io_no, label: `I/O: ${row.io_no}`, link: `/production/traceability?io=${encodeURIComponent(row.io_no)}` });
  }

  // 2. Search Style No
  const styles = await query(
    `SELECT id, style_code, style_name FROM mst_style WHERE (style_code LIKE ? OR style_name LIKE ?) AND company_id = ? LIMIT 5`,
    [`%${q}%`, `%${q}%`, cid]);
  for (const s of styles as any[]) {
    results.push({ type: 'STYLE', key: s.style_code, label: `Style: ${s.style_code} (${s.style_name})`, link: `/production/traceability?style=${encodeURIComponent(s.style_code)}` });
  }

  // 3. Search Bundle No or Barcode
  const bundles = await query(
    `SELECT cb.id, cb.bundle_no, cb.barcode, cb.io_no, cb.qty, cb.status
       FROM trx_cutting_bundle cb
      WHERE (cb.bundle_no LIKE ? OR cb.barcode LIKE ?) LIMIT 5`, [`%${q}%`, `%${q}%`]);
  for (const b of bundles as any[]) {
    results.push({ type: 'BUNDLE', key: b.bundle_no, label: `Bundle: ${b.bundle_no} (I/O: ${b.io_no}, Qty: ${b.qty}, ${b.status})`, link: `/production/traceability?bundle=${encodeURIComponent(b.bundle_no)}` });
  }

  // 4. Search Carton / Package No
  const cartons = await query(
    `SELECT c.id, c.carton_no, p.io_no, p.pack_no, c.gross_weight_kg, c.cbm
       FROM trx_carton c
       JOIN trx_packing p ON p.id = c.packing_id
      WHERE (c.carton_no LIKE ? OR c.barcode LIKE ?) AND p.company_id = ? LIMIT 5`, [`%${q}%`, `%${q}%`, cid]);
  for (const c of cartons as any[]) {
    results.push({ type: 'CARTON', key: c.carton_no, label: `Carton: ${c.carton_no} (Pack: ${c.pack_no}, Wt: ${c.gross_weight_kg}kg)`, link: `/production/traceability?carton=${encodeURIComponent(c.carton_no)}` });
  }

  // 5. Search Fabric Roll No
  const rolls = await query(
    `SELECT fir.roll_no, fir.lot_no, fi.issue_no, fi.io_no
       FROM trx_fabric_issue_roll fir
       JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE (fir.roll_no LIKE ? OR fir.lot_no LIKE ?) AND fi.company_id = ? LIMIT 5`, [`%${q}%`, `%${q}%`, cid]);
  for (const r of rolls as any[]) {
    results.push({ type: 'ROLL', key: r.roll_no, label: `Roll: ${r.roll_no} (Lot: ${r.lot_no}, Issue: ${r.issue_no})`, link: `/production/traceability?roll=${encodeURIComponent(r.roll_no)}` });
  }

  res.json({ data: results });
}));
