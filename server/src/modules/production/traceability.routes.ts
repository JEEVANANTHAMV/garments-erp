import { Router } from 'express';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import {
  buildBundleTrace, traceBundleBothWays, traceForwardFromFabric, traceBackFromCarton, traceBackFromShipment,
} from './bundleTrace.js';

export const traceabilityRouter = Router();

/**
 * GET /production/io/:ioNo/styles
 * Returns all styles, order quantities, and variants under a specific I/O No.
 */
traceabilityRouter.get('/production/io/:ioNo/styles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const ioNo = req.params.ioNo;

  // Check across production orders and sales orders for this IO
  // Styles live on the sales-order lines (trx_sales_order has no style_id).
  const styles = await query(
    `SELECT st.id AS style_id, st.style_code, st.style_name,
            so.id AS so_id, so.so_no,
            po.id AS prod_order_id, po.po_prod_no,
            SUM(sol.order_qty) AS total_order_qty
       FROM trx_sales_order so
       JOIN trx_sales_order_line sol ON sol.so_id = so.id
       LEFT JOIN mst_style st ON st.id = sol.style_id
       LEFT JOIN trx_production_order po ON po.so_id = so.id AND po.style_id = sol.style_id
      WHERE (so.io_no = ? OR so.buyer_po_no = ? OR so.so_no = ? OR po.io_no = ?) AND so.company_id = ?
      GROUP BY st.id, st.style_code, st.style_name, so.id, so.so_no, po.id, po.po_prod_no`,
    [ioNo, ioNo, ioNo, ioNo, cid]);

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
    query(`SELECT id, so_no, so_date, order_qty, buyer_id FROM trx_sales_order WHERE (so_no = ? OR buyer_po_no = ? OR io_no = ?) AND company_id = ?`, [ioNo, ioNo, ioNo, cid]),
    query(`SELECT id, po_prod_no, prod_date, order_qty, planned_qty FROM trx_production_order WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, plan_no, plan_date, style_id, color_id, order_qty, planned_cut_qty, actual_cut_qty, status FROM trx_cutting_plan WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, issue_no, issue_date, total_rolls, total_mtr, total_kg, status FROM trx_fabric_issue WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, lay_no, lay_date, marker_ref, ply_count, planned_cut_qty, status FROM trx_lay_plan WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, cut_no, cut_date, total_pieces, marker_ref, ply_count FROM trx_cutting WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT id, qc_no, qc_date, component, cut_qty, accepted_qty, reject_qty, recut_qty, qc_status FROM trx_cut_piece_qc WHERE io_no = ? AND company_id = ?`, [ioNo, cid]),
    query(`SELECT cb.id, cb.bundle_no, cb.barcode, cb.qty, cb.balance_qty, cb.status FROM trx_cutting_bundle cb
             LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
            WHERE cb.io_no = ? AND COALESCE(cb.company_id, c.company_id) = ?`, [ioNo, cid]),
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
    query(`SELECT so.so_no, so.so_date, SUM(sol.order_qty) AS order_qty, po.po_prod_no, COALESCE(po.io_no, so.io_no) AS io_no
             FROM trx_sales_order so
             JOIN trx_sales_order_line sol ON sol.so_id = so.id
             LEFT JOIN trx_production_order po ON po.so_id = so.id AND po.style_id = sol.style_id
            WHERE sol.style_id = ? AND so.company_id = ?
            GROUP BY so.id, so.so_no, so.so_date, po.id, po.po_prod_no, po.io_no, so.io_no`, [style.id, cid]),
    query(`SELECT cp.plan_no, cp.io_no, cp.planned_cut_qty, cp.actual_cut_qty, cp.status
             FROM trx_cutting_plan cp
            WHERE cp.style_id = ? AND cp.company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(actual_cut_qty),0) AS total_cut FROM trx_cutting_plan WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(total_qty),0) AS total_fg FROM trx_fg_receipt WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    queryOne<any>(`SELECT COALESCE(SUM(total_qty),0) AS total_packed FROM trx_packing WHERE style_id = ? AND company_id = ?`, [style.id, cid]),
    // trx_shipment has no style_id: a shipment belongs to a style through its
    // sales order lines or through the packing of its packing list.
    queryOne<any>(`SELECT COALESCE(SUM(sh.total_qty),0) AS total_shipped
                     FROM trx_shipment sh
                    WHERE sh.company_id = ?
                      AND (sh.so_id IN (SELECT sol.so_id FROM trx_sales_order_line sol WHERE sol.style_id = ?)
                           OR sh.packing_list_id IN (SELECT pl.id FROM trx_packing_list pl JOIN trx_packing p ON p.id = pl.packing_id
                                                      WHERE p.style_id = ?))`, [cid, style.id, style.id]),
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
       FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE (cb.bundle_no LIKE ? OR cb.barcode LIKE ?) AND COALESCE(cb.company_id, c.company_id) = ? LIMIT 5`,
    [`%${q}%`, `%${q}%`, cid]);
  for (const b of bundles as any[]) {
    const key = b.barcode || b.bundle_no;
    results.push({ type: 'BUNDLE', key, label: `Bundle: ${b.bundle_no} (I/O: ${b.io_no}, Qty: ${b.qty} PCS, ${b.status})`, link: `/production/traceability?bundle=${encodeURIComponent(key)}` });
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
  // Roll stock (rolls not yet issued are still traceable to GRN/PO)
  const stockRolls = await query(
    `SELECT DISTINCT roll_no, lot_no FROM trx_fabric_roll WHERE company_id = ? AND (roll_no LIKE ? OR lot_no LIKE ?) LIMIT 5`,
    [cid, `%${q}%`, `%${q}%`]);
  for (const r of stockRolls as any[]) {
    if (!results.some((x) => x.type === 'ROLL' && x.key === r.roll_no)) {
      results.push({ type: 'ROLL', key: r.roll_no, label: `Roll: ${r.roll_no} (Lot: ${r.lot_no ?? '—'})`, link: `/production/traceability?roll=${encodeURIComponent(r.roll_no)}` });
    }
    if (r.lot_no && String(r.lot_no).toLowerCase().includes(q.toLowerCase()) && !results.some((x) => x.type === 'LOT' && x.key === r.lot_no)) {
      results.push({ type: 'LOT', key: r.lot_no, label: `Fabric lot: ${r.lot_no}`, link: `/production/traceability?lot=${encodeURIComponent(r.lot_no)}` });
    }
  }

  // 6. Shipments
  const ships = await query(
    `SELECT shipment_no, io_no, total_qty FROM trx_shipment WHERE company_id = ? AND shipment_no LIKE ? LIMIT 5`, [cid, `%${q}%`]);
  for (const sh of ships as any[]) {
    results.push({ type: 'SHIPMENT', key: sh.shipment_no, label: `Shipment: ${sh.shipment_no} (I/O: ${sh.io_no ?? '—'}, ${sh.total_qty ?? 0} PCS)`, link: `/production/traceability?shipment=${encodeURIComponent(sh.shipment_no)}` });
  }

  res.json({ data: results });
}));

// ============================================================
// Fabric ⇄ shipment trace (doc §23, §25 drill-down both ways)
//   GET /trace/bundle/:code      bundle → up to rolls/GRN/PO and down to shipment
//   GET /trace/roll/:rollNo      forward: roll → DC → lays → cut outputs → bundles → cartons → PL → shipment
//   GET /trace/lot/:lotNo        forward from every roll of a fabric lot
//   GET /trace/carton/:code      backward: carton → bundles → lays → rolls → lot → GRN → PO
//   GET /trace/shipment/:no      backward from a shipment
// ============================================================
const traceCode = (v: unknown) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > 120) throw BadRequest('Enter a code to trace');
  return s;
};

traceabilityRouter.get('/trace/bundle/:code', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const code = traceCode(req.params.code);
  const b = await queryOne<any>(
    `SELECT cb.id FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE (cb.barcode = ? OR cb.bundle_no = ?) AND COALESCE(cb.company_id, c.company_id) = ?
      ORDER BY (cb.barcode = ?) DESC, cb.id DESC LIMIT 1`, [code, code, cid, code]);
  if (!b) throw NotFound(`Bundle ${code} not found`);
  const [chain, bundle] = await Promise.all([traceBundleBothWays(cid, b.id), buildBundleTrace(cid, b.id)]);
  res.json({ data: { ...chain, bundle } });
}));

traceabilityRouter.get('/trace/roll/:rollNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const data = await traceForwardFromFabric(req.user!.companyId, { roll: traceCode(req.params.rollNo) });
  if (!data.rolls.length && !data.dcRolls.length) throw NotFound(`Fabric roll ${req.params.rollNo} not found`);
  res.json({ data });
}));

traceabilityRouter.get('/trace/lot/:lotNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const data = await traceForwardFromFabric(req.user!.companyId, { lot: traceCode(req.params.lotNo) });
  if (!data.rolls.length && !data.dcRolls.length) throw NotFound(`Fabric lot ${req.params.lotNo} not found`);
  res.json({ data });
}));

traceabilityRouter.get('/trace/carton/:code', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const data = await traceBackFromCarton(req.user!.companyId, traceCode(req.params.code));
  if (!data) throw NotFound(`Carton ${req.params.code} not found`);
  res.json({ data });
}));

traceabilityRouter.get('/trace/shipment/:no', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const data = await traceBackFromShipment(req.user!.companyId, traceCode(req.params.no));
  if (!data) throw NotFound(`Shipment ${req.params.no} not found`);
  res.json({ data });
}));
