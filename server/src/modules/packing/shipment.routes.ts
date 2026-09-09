import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const shipmentRouter = Router();

// ============================================================
// PACKING LIST
// ============================================================

const packingListSchema = z.object({
  pl_no: s.nullableStr(40),
  pl_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.nullableStr(40),
  so_id: s.id(),
  packing_id: s.id(),
  invoice_id: s.id(),
  buyer_id: s.id(),
  consignee_id: s.id(),
  shipment_type: z.enum(['DOMESTIC', 'EXPORT']).default('DOMESTIC'),
  destination: s.nullableStr(120),
  status: z.enum(['DRAFT', 'CONFIRMED', 'CLOSED']).default('DRAFT'),
});

/** GET /packing-lists — All packing lists */
shipmentRouter.get('/packing-lists', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT pl.*,
            p.pack_no,
            so.so_no,
            b.party_name AS buyer_name,
            con.party_name AS consignee_name
       FROM trx_packing_list pl
       LEFT JOIN trx_packing p ON p.id = pl.packing_id
       LEFT JOIN trx_sales_order so ON so.id = pl.so_id
       LEFT JOIN mst_party b ON b.id = pl.buyer_id
       LEFT JOIN mst_party con ON con.id = pl.consignee_id
      WHERE pl.company_id = ?
      ORDER BY pl.pl_date DESC, pl.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /packing-lists/:id — Single packing list with carton details */
shipmentRouter.get('/packing-lists/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);

  const row = await queryOne(
    `SELECT pl.*,
            p.pack_no,
            so.so_no,
            b.party_name AS buyer_name,
            con.party_name AS consignee_name
       FROM trx_packing_list pl
       LEFT JOIN trx_packing p ON p.id = pl.packing_id
       LEFT JOIN trx_sales_order so ON so.id = pl.so_id
       LEFT JOIN mst_party b ON b.id = pl.buyer_id
       LEFT JOIN mst_party con ON con.id = pl.consignee_id
      WHERE pl.id = ? AND pl.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Packing list not found');

  // Get carton details from the linked packing
  const packingId = (row as any).packing_id;
  let cartons: any[] = [];
  if (packingId) {
    cartons = await query(
      `SELECT c.*, 
              GROUP_CONCAT(CONCAT(sz.size_code, ':', cc.qty) ORDER BY sz.sort_order SEPARATOR ', ') AS size_summary
         FROM trx_carton c
         LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
         LEFT JOIN mst_style_sku k ON k.id = cc.sku_id
         LEFT JOIN mst_size sz ON sz.id = k.size_id
        WHERE c.packing_id = ?
        GROUP BY c.id
        ORDER BY c.carton_no`, [packingId]);
  }

  // Style/colour/size summary
  const summary = packingId ? await query(
    `SELECT col.color_name, sz.size_code, sz.sort_order, SUM(cc.qty) AS total_qty
       FROM trx_carton_content cc
       JOIN trx_carton c ON c.id = cc.carton_id
       JOIN mst_style_sku k ON k.id = cc.sku_id
       JOIN mst_color col ON col.id = k.color_id
       JOIN mst_size sz ON sz.id = k.size_id
      WHERE c.packing_id = ?
      GROUP BY col.color_name, sz.size_code, sz.sort_order
      ORDER BY col.color_name, sz.sort_order`, [packingId]) : [];

  res.json({ data: { ...(row as any), cartons, summary } });
}));

/** POST /packing-lists — Create packing list */
shipmentRouter.post('/packing-lists', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = packingListSchema.parse(req.body);

  // Auto-calculate totals from the linked packing
  let totalCartons = 0, totalQty = 0, netWt = 0, grossWt = 0, totalCbm = 0;
  if (body.packing_id) {
    const agg = await queryOne<any>(
      `SELECT total_cartons, total_qty, net_weight_kg, gross_weight_kg FROM trx_packing WHERE id = ?`,
      [body.packing_id]);
    if (agg) {
      totalCartons = agg.total_cartons || 0;
      totalQty = agg.total_qty || 0;
      netWt = agg.net_weight_kg || 0;
      grossWt = agg.gross_weight_kg || 0;
    }
    const cbmRow = await queryOne<any>(
      `SELECT COALESCE(SUM(cbm), 0) AS total_cbm FROM trx_carton WHERE packing_id = ?`,
      [body.packing_id]);
    totalCbm = cbmRow?.total_cbm || 0;
  }

  const result = await transaction(async (tx) => {
    const plNo = body.pl_no || await nextDocNumber(tx, cid, 'PACKING_LIST');

    const r = await txExecute(tx,
      `INSERT INTO trx_packing_list
        (company_id, pl_no, pl_date, io_no, so_id, packing_id, invoice_id, buyer_id, consignee_id,
         shipment_type, destination, total_cartons, total_qty, net_weight_kg, gross_weight_kg, total_cbm, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, plNo, body.pl_date, body.io_no ?? null, body.so_id ?? null,
       body.packing_id ?? null, body.invoice_id ?? null, body.buyer_id ?? null, body.consignee_id ?? null,
       body.shipment_type, body.destination ?? null, totalCartons, totalQty, netWt, grossWt, totalCbm,
       body.status]);

    return txQueryOne(tx, `SELECT * FROM trx_packing_list WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_packing_list', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** POST /packing-lists/:id/confirm — Confirm packing list */
shipmentRouter.post('/packing-lists/:id/confirm', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);

  const pl = await queryOne<any>(`SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!pl) throw NotFound('Packing list not found');
  if (pl.status === 'CONFIRMED') throw BadRequest('Already confirmed');

  await query(`UPDATE trx_packing_list SET status = 'CONFIRMED' WHERE id = ?`, [id]);
  res.json({ data: { id, status: 'CONFIRMED' } });
}));


// ============================================================
// SHIPMENT
// ============================================================

const MODES = ['SEA', 'AIR', 'ROAD', 'COURIER'] as const;
const INCOTERMS = ['FOB', 'CIF', 'CFR', 'EXW', 'DDP', 'DAP', 'FCA'] as const;
const SHIP_TYPES = ['DOMESTIC', 'EXPORT'] as const;

const shipmentSchema = z.object({
  shipment_no: s.nullableStr(40),
  io_no: s.nullableStr(40),
  so_id: s.id(),
  packing_list_id: s.id(),
  buyer_id: s.id(),
  consignee_id: s.id(),
  notify_party_id: s.id(),
  shipment_type: z.enum(SHIP_TYPES).default('DOMESTIC'),
  mode: z.enum(MODES).default('ROAD'),
  incoterm: z.enum(INCOTERMS).nullish(),
  destination: s.nullableStr(120),
  country_id: s.id(),
  freight_terms: s.nullableStr(80),
  remarks: s.text(),
  // Export-specific
  invoice_id: s.id(),
  dispatch_id: s.id(),
  shipping_bill_id: s.id(),
  forwarder_id: s.id(),
  shipping_line: s.nullableStr(120),
  vessel_name: s.nullableStr(120),
  voyage_no: s.nullableStr(40),
  bl_no: s.nullableStr(60),
  bl_date: s.date(),
  etd: s.date(),
  eta: s.date(),
  pol: s.nullableStr(80),
  pod: s.nullableStr(80),
  // Packages to allocate
  package_ids: z.array(z.coerce.number().int().positive()).default([]),
});

/** GET /shipments — List all shipments */
shipmentRouter.get('/shipments', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT sh.*,
            pl.pl_no AS packing_list_no,
            b.party_name AS buyer_name,
            con.party_name AS consignee_name,
            so.so_no,
            st.label AS status_label
       FROM trx_shipment sh
       LEFT JOIN trx_packing_list pl ON pl.id = sh.packing_list_id
       LEFT JOIN mst_party b ON b.id = sh.buyer_id
       LEFT JOIN mst_party con ON con.id = sh.consignee_id
       LEFT JOIN trx_sales_order so ON so.id = sh.so_id
       LEFT JOIN cfg_status st ON st.id = sh.status_id
      WHERE sh.company_id = ?
      ORDER BY sh.created_at DESC, sh.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /shipments/:id — Shipment detail with packages */
shipmentRouter.get('/shipments/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);

  const row = await queryOne(
    `SELECT sh.*,
            pl.pl_no AS packing_list_no,
            b.party_name AS buyer_name,
            con.party_name AS consignee_name,
            so.so_no,
            st.label AS status_label,
            fw.party_name AS forwarder_name
       FROM trx_shipment sh
       LEFT JOIN trx_packing_list pl ON pl.id = sh.packing_list_id
       LEFT JOIN mst_party b ON b.id = sh.buyer_id
       LEFT JOIN mst_party con ON con.id = sh.consignee_id
       LEFT JOIN trx_sales_order so ON so.id = sh.so_id
       LEFT JOIN cfg_status st ON st.id = sh.status_id
       LEFT JOIN mst_party fw ON fw.id = sh.forwarder_id
      WHERE sh.id = ? AND sh.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Shipment not found');

  // Allocated packages
  const packages = await query(
    `SELECT sp.*, c.carton_no, c.carton_type, c.net_weight_kg AS carton_net, c.gross_weight_kg AS carton_gross,
            c.cbm AS carton_cbm, p.pack_no
       FROM trx_shipment_package sp
       JOIN trx_carton c ON c.id = sp.carton_id
       LEFT JOIN trx_packing p ON p.id = sp.packing_id
      WHERE sp.shipment_id = ?
      ORDER BY c.carton_no`, [id]);

  // Item summary
  const itemSummary = await query(
    `SELECT sis.*, st.style_code, col.color_name, sz.size_code
       FROM trx_shipment_item_summary sis
       LEFT JOIN mst_style st ON st.id = sis.style_id
       LEFT JOIN mst_color col ON col.id = sis.color_id
       LEFT JOIN mst_size sz ON sz.id = sis.size_id
      WHERE sis.shipment_id = ?
      ORDER BY st.style_code, col.color_name, sz.sort_order`, [id]);

  // Documents
  const documents = await query(
    `SELECT sd.*, dt.doc_code, dt.doc_name
       FROM trx_shipment_document sd
       JOIN cfg_shipment_doc_type dt ON dt.id = sd.doc_type_id
      WHERE sd.shipment_id = ?
      ORDER BY dt.sort_order`, [id]);

  res.json({ data: { ...(row as any), packages, itemSummary, documents } });
}));

/** POST /shipments — Create shipment with package allocation */
shipmentRouter.post('/shipments', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = shipmentSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const shipNo = body.shipment_no || await nextDocNumber(tx, cid, 'SHIPMENT');

    const r = await txExecute(tx,
      `INSERT INTO trx_shipment
        (company_id, shipment_no, io_no, so_id, packing_list_id, buyer_id, consignee_id,
         notify_party_id, shipment_type, mode, incoterm, destination, country_id, freight_terms,
         invoice_id, dispatch_id, shipping_bill_id, forwarder_id, shipping_line, vessel_name,
         voyage_no, bl_no, bl_date, etd, eta, pol, pod, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, shipNo, body.io_no ?? null, body.so_id ?? null, body.packing_list_id ?? null,
       body.buyer_id ?? null, body.consignee_id ?? null, body.notify_party_id ?? null,
       body.shipment_type, body.mode, body.incoterm ?? null, body.destination ?? null,
       body.country_id ?? null, body.freight_terms ?? null,
       body.invoice_id ?? null, body.dispatch_id ?? null, body.shipping_bill_id ?? null,
       body.forwarder_id ?? null, body.shipping_line ?? null, body.vessel_name ?? null,
       body.voyage_no ?? null, body.bl_no ?? null, body.bl_date ?? null,
       body.etd ?? null, body.eta ?? null, body.pol ?? null, body.pod ?? null,
       body.remarks ?? null, req.user!.id]);

    const shipmentId = r.insertId;

    // Allocate packages (cartons)
    let totalPkgs = 0, totalQty = 0, totalNet = 0, totalGross = 0, totalCbm = 0;
    for (const cartonId of body.package_ids) {
      // Check carton is not already allocated to another active shipment
      const existing = await txQueryOne<any>(tx,
        `SELECT sp.id FROM trx_shipment_package sp
           JOIN trx_shipment s ON s.id = sp.shipment_id
          WHERE sp.carton_id = ? AND sp.status != 'CANCELLED'`, [cartonId]);
      if (existing) continue; // skip already allocated

      const carton = await txQueryOne<any>(tx,
        `SELECT c.*, COALESCE(SUM(cc.qty), 0) AS content_qty
           FROM trx_carton c
           LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
          WHERE c.id = ? GROUP BY c.id`, [cartonId]);
      if (!carton) continue;

      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`,
        [shipmentId, cartonId, carton.packing_id, carton.carton_no,
         carton.content_qty, carton.gross_weight_kg, carton.cbm]);

      totalPkgs++;
      totalQty += Number(carton.content_qty || 0);
      totalNet += Number(carton.net_weight_kg || 0);
      totalGross += Number(carton.gross_weight_kg || 0);
      totalCbm += Number(carton.cbm || 0);
    }

    // Update shipment totals
    await txExecute(tx,
      `UPDATE trx_shipment SET total_packages = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?, total_cbm = ?
       WHERE id = ?`,
      [totalPkgs, totalQty, totalNet, totalGross, totalCbm, shipmentId]);

    return txQueryOne(tx, `SELECT * FROM trx_shipment WHERE id = ?`, [shipmentId]);
  });

  await audit(req, 'trx_shipment', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** POST /shipments/:id/allocate-packages — Add more packages to shipment */
shipmentRouter.post('/shipments/:id/allocate-packages', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const shipmentId = Number(req.params.id);
  const { package_ids } = z.object({
    package_ids: z.array(z.coerce.number().int().positive()).min(1),
  }).parse(req.body);

  const shipment = await queryOne<any>(`SELECT * FROM trx_shipment WHERE id = ? AND company_id = ?`, [shipmentId, cid]);
  if (!shipment) throw NotFound('Shipment not found');

  let allocated = 0;
  await transaction(async (tx) => {
    for (const cartonId of package_ids) {
      const existing = await txQueryOne<any>(tx,
        `SELECT id FROM trx_shipment_package WHERE carton_id = ? AND status != 'CANCELLED'`, [cartonId]);
      if (existing) continue;

      const carton = await txQueryOne<any>(tx,
        `SELECT c.*, COALESCE(SUM(cc.qty), 0) AS content_qty
           FROM trx_carton c LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
          WHERE c.id = ? GROUP BY c.id`, [cartonId]);
      if (!carton) continue;

      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`,
        [shipmentId, cartonId, carton.packing_id, carton.carton_no,
         carton.content_qty, carton.gross_weight_kg, carton.cbm]);
      allocated++;
    }

    // Recalculate shipment totals
    const agg = await txQueryOne<any>(tx,
      `SELECT COUNT(*) AS pkgs, COALESCE(SUM(allocated_qty),0) AS qty,
              COALESCE(SUM(gross_weight_kg),0) AS gross, COALESCE(SUM(cbm),0) AS cbm
         FROM trx_shipment_package WHERE shipment_id = ? AND status != 'CANCELLED'`, [shipmentId]);
    await txExecute(tx,
      `UPDATE trx_shipment SET total_packages = ?, total_qty = ?, gross_weight_kg = ?, total_cbm = ? WHERE id = ?`,
      [agg?.pkgs || 0, agg?.qty || 0, agg?.gross || 0, agg?.cbm || 0, shipmentId]);
  });

  res.json({ data: { allocated } });
}));


// ============================================================
// DISPATCH
// ============================================================

const dispatchSchema = z.object({
  dispatch_no: s.nullableStr(40),
  dispatch_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.nullableStr(40),
  so_id: s.id(),
  shipment_id: s.id(),
  packing_id: s.id(),
  buyer_id: s.id(),
  transporter_id: s.id(),
  vehicle_no: s.nullableStr(20),
  driver_name: s.nullableStr(80),
  lr_no: s.nullableStr(40),
  lr_date: s.date(),
  eway_bill_no: s.nullableStr(40),
  dispatch_time: s.nullableStr(8),
  delivery_location: s.nullableStr(120),
  mode: z.enum(MODES).default('ROAD'),
  total_cartons: z.coerce.number().int().min(0).default(0),
  total_qty: z.coerce.number().int().min(0).default(0),
  gross_weight_kg: s.dec(),
  total_cbm: s.dec(),
  status_id: s.id(),
  remarks: s.text(),
});

/** GET /dispatches — List dispatches */
shipmentRouter.get('/dispatches', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT d.*,
            so.so_no,
            b.party_name AS buyer_name,
            sh.shipment_no,
            tp.party_name AS transporter_name,
            cs.label AS status_label
       FROM trx_dispatch d
       LEFT JOIN trx_sales_order so ON so.id = d.so_id
       LEFT JOIN mst_party b ON b.id = d.buyer_id
       LEFT JOIN trx_shipment sh ON sh.id = d.shipment_id
       LEFT JOIN mst_party tp ON tp.id = d.transporter_id
       LEFT JOIN cfg_status cs ON cs.id = d.status_id
      WHERE d.company_id = ?
      ORDER BY d.dispatch_date DESC, d.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /dispatches/:id — Dispatch detail */
shipmentRouter.get('/dispatches/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT d.*,
            so.so_no,
            b.party_name AS buyer_name,
            sh.shipment_no,
            tp.party_name AS transporter_name,
            cs.label AS status_label
       FROM trx_dispatch d
       LEFT JOIN trx_sales_order so ON so.id = d.so_id
       LEFT JOIN mst_party b ON b.id = d.buyer_id
       LEFT JOIN trx_shipment sh ON sh.id = d.shipment_id
       LEFT JOIN mst_party tp ON tp.id = d.transporter_id
       LEFT JOIN cfg_status cs ON cs.id = d.status_id
      WHERE d.id = ? AND d.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Dispatch not found');
  res.json({ data: row });
}));

/** POST /dispatches — Create dispatch */
shipmentRouter.post('/dispatches', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = dispatchSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const dispNo = body.dispatch_no || await nextDocNumber(tx, cid, 'DISPATCH');

    const r = await txExecute(tx,
      `INSERT INTO trx_dispatch
        (company_id, dispatch_no, dispatch_date, io_no, so_id, shipment_id, packing_id, buyer_id,
         transporter_id, vehicle_no, driver_name, lr_no, lr_date, eway_bill_no, dispatch_time,
         delivery_location, mode, total_cartons, total_qty, gross_weight_kg, total_cbm, status_id, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, dispNo, body.dispatch_date, body.io_no ?? null, body.so_id ?? null,
       body.shipment_id ?? null, body.packing_id ?? null, body.buyer_id ?? null,
       body.transporter_id ?? null, body.vehicle_no ?? null, body.driver_name ?? null,
       body.lr_no ?? null, body.lr_date ?? null, body.eway_bill_no ?? null,
       body.dispatch_time ?? null, body.delivery_location ?? null,
       body.mode, body.total_cartons, body.total_qty, body.gross_weight_kg ?? null,
       body.total_cbm ?? null, body.status_id ?? null, body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_dispatch WHERE id = ?`, [r.insertId]);
  });

  // Update shipment package statuses
  if (body.shipment_id) {
    await query(
      `UPDATE trx_shipment_package SET status = 'DISPATCHED' WHERE shipment_id = ? AND status = 'ALLOCATED'`,
      [body.shipment_id]);
    await query(
      `UPDATE trx_shipment SET tracking_status = 'GATED_IN' WHERE id = ?`, [body.shipment_id]);
  }

  await audit(req, 'trx_dispatch', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));


// ============================================================
// AVAILABLE PACKAGES FOR SHIPMENT
// ============================================================

/** GET /available-packages — Get cartons not yet allocated to any active shipment */
shipmentRouter.get('/available-packages', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const packingId = req.query.packing_id ? Number(req.query.packing_id) : null;

  let sql = `SELECT c.*, p.pack_no, p.so_id,
                    COALESCE(SUM(cc.qty), 0) AS content_qty,
                    GROUP_CONCAT(DISTINCT CONCAT(col.color_name, ' ', sz.size_code) SEPARATOR ', ') AS sku_summary
               FROM trx_carton c
               JOIN trx_packing p ON p.id = c.packing_id
               LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
               LEFT JOIN mst_style_sku k ON k.id = cc.sku_id
               LEFT JOIN mst_color col ON col.id = k.color_id
               LEFT JOIN mst_size sz ON sz.id = k.size_id
              WHERE p.company_id = ?
                AND c.id NOT IN (
                  SELECT sp.carton_id FROM trx_shipment_package sp WHERE sp.status != 'CANCELLED'
                )`;
  const params: any[] = [cid];

  if (packingId) {
    sql += ` AND c.packing_id = ?`;
    params.push(packingId);
  }
  sql += ` GROUP BY c.id ORDER BY c.carton_no`;

  const rows = await query(sql, params);
  res.json({ data: rows });
}));


// ============================================================
// SHIPMENT DOCUMENT TYPES
// ============================================================

/** GET /shipment-doc-types — List document types */
shipmentRouter.get('/shipment-doc-types', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT * FROM cfg_shipment_doc_type WHERE company_id = ? AND is_active = 1 ORDER BY sort_order`, [cid]);
  res.json({ data: rows });
}));

/** POST /shipments/:id/documents — Attach document to shipment */
shipmentRouter.post('/shipments/:id/documents', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const shipmentId = Number(req.params.id);
  const body = z.object({
    doc_type_id: s.idReq(),
    document_no: s.nullableStr(60),
    file_path: s.nullableStr(255),
    status: z.enum(['PENDING', 'PREPARED', 'VERIFIED']).default('PENDING'),
    remarks: s.nullableStr(255),
  }).parse(req.body);

  const r = await query(
    `INSERT INTO trx_shipment_document (shipment_id, doc_type_id, document_no, file_path, status, remarks)
     VALUES (?,?,?,?,?,?)`,
    [shipmentId, body.doc_type_id, body.document_no ?? null, body.file_path ?? null,
     body.status, body.remarks ?? null]);

  res.status(201).json({ data: { id: (r as any).insertId } });
}));


// ============================================================
// SHIPMENT PLANNING
// ============================================================

/** GET /shipment-plans */
shipmentRouter.get('/shipment-plans', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT sp.*, b.party_name AS buyer_name
       FROM trx_shipment_plan sp
       LEFT JOIN mst_party b ON b.id = sp.buyer_id
      WHERE sp.company_id = ?
      ORDER BY sp.planned_date DESC, sp.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /shipment-plans/:id */
shipmentRouter.get('/shipment-plans/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT sp.*, b.party_name AS buyer_name
       FROM trx_shipment_plan sp
       LEFT JOIN mst_party b ON b.id = sp.buyer_id
      WHERE sp.id = ? AND sp.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Shipment plan not found');

  const packages = await query(
    `SELECT c.*, p.pack_no
       FROM trx_shipment_plan_package spp
       JOIN trx_carton c ON c.id = spp.carton_id
       JOIN trx_packing p ON p.id = c.packing_id
      WHERE spp.plan_id = ?`, [id]);

  res.json({ data: { ...(row as any), packages } });
}));

/** POST /shipment-plans */
shipmentRouter.post('/shipment-plans', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    plan_no: s.nullableStr(40),
    planned_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    buyer_id: s.id(),
    shipment_type: z.enum(['DOMESTIC','EXPORT']).default('DOMESTIC'),
    mode: z.enum(MODES).default('ROAD'),
    destination: s.nullableStr(120),
    package_ids: z.array(z.coerce.number().int().positive()).default([]),
    remarks: s.text(),
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    const planNo = body.plan_no || await nextDocNumber(tx, cid, 'SHIP_PLAN');

    let totalGross = 0, totalCbm = 0, totalQty = 0;
    for (const pkgId of body.package_ids) {
      const c = await txQueryOne<any>(tx,
        `SELECT c.*, COALESCE(SUM(cc.qty),0) AS qty
           FROM trx_carton c LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
          WHERE c.id = ? GROUP BY c.id`, [pkgId]);
      if (c) {
        totalGross += Number(c.gross_weight_kg || 0);
        totalCbm += Number(c.cbm || 0);
        totalQty += Number(c.qty || 0);
      }
    }

    const r = await txExecute(tx,
      `INSERT INTO trx_shipment_plan
        (company_id, plan_no, planned_date, buyer_id, shipment_type, mode, destination,
         total_packages, total_qty, gross_weight_kg, total_cbm, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, body.planned_date, body.buyer_id ?? null, body.shipment_type, body.mode,
       body.destination ?? null, body.package_ids.length, totalQty, totalGross, totalCbm,
       'DRAFT', body.remarks ?? null, req.user!.id]);

    const planId = r.insertId;
    for (const pkgId of body.package_ids) {
      await txExecute(tx,
        `INSERT INTO trx_shipment_plan_package (plan_id, carton_id) VALUES (?,?)`, [planId, pkgId]);
    }
    return txQueryOne(tx, `SELECT * FROM trx_shipment_plan WHERE id = ?`, [planId]);
  });

  res.status(201).json({ data: result });
}));

/** POST /shipment-plans/:id/convert — Convert plan directly to Draft Shipment */
shipmentRouter.post('/shipment-plans/:id/convert', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const planId = Number(req.params.id);

  const plan = await queryOne<any>(
    `SELECT * FROM trx_shipment_plan WHERE id = ? AND company_id = ?`, [planId, cid]);
  if (!plan) throw NotFound('Shipment plan not found');

  const pkgs = await query<any>(
    `SELECT carton_id FROM trx_shipment_plan_package WHERE plan_id = ?`, [planId]);
  const packageIds = pkgs.map(p => p.carton_id);

  const shipment = await transaction(async (tx) => {
    const shipNo = await nextDocNumber(tx, cid, 'SHIPMENT');
    const r = await txExecute(tx,
      `INSERT INTO trx_shipment
        (company_id, shipment_no, buyer_id, shipment_type, mode, destination,
         total_packages, total_qty, gross_weight_kg, total_cbm, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, shipNo, plan.buyer_id, plan.shipment_type, plan.mode, plan.destination,
       plan.total_packages, plan.total_qty, plan.gross_weight_kg, plan.total_cbm,
       `Converted from Plan ${plan.plan_no}`, req.user!.id]);

    const shipId = r.insertId;

    for (const cartonId of packageIds) {
      const carton = await txQueryOne<any>(tx,
        `SELECT c.*, COALESCE(SUM(cc.qty), 0) AS content_qty
           FROM trx_carton c LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
          WHERE c.id = ? GROUP BY c.id`, [cartonId]);
      if (!carton) continue;

      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`,
        [shipId, cartonId, carton.packing_id, carton.carton_no,
         carton.content_qty, carton.gross_weight_kg, carton.cbm]);
    }

    await txExecute(tx, `UPDATE trx_shipment_plan SET status = 'CONVERTED' WHERE id = ?`, [planId]);

    return txQueryOne(tx, `SELECT * FROM trx_shipment WHERE id = ?`, [shipId]);
  });

  res.json({ data: shipment });
}));


// ============================================================
// CONTAINERS
// ============================================================

/** GET /shipments/:id/containers */
shipmentRouter.get('/shipments/:id/containers', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const shipmentId = Number(req.params.id);
  const rows = await query(
    `SELECT * FROM trx_shipment_container WHERE shipment_id = ? AND company_id = ? ORDER BY id DESC`,
    [shipmentId, cid]);
  res.json({ data: rows });
}));

/** POST /shipments/:id/containers */
shipmentRouter.post('/shipments/:id/containers', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const shipmentId = Number(req.params.id);
  const body = z.object({
    container_no: s.strReq(40),
    container_type: z.enum(['20FT','40FT','40HC','45HC','LCL']).default('40HC'),
    seal_no: s.nullableStr(40),
    tare_weight_kg: s.dec(),
    net_weight_kg: s.dec(),
    gross_weight_kg: s.dec(),
    max_cbm: s.dec(),
    loaded_cbm: s.dec(),
    stuffing_date: s.date(),
    stuffing_location: s.nullableStr(120),
    status: z.enum(['PLANNED','STUFFED','RELEASED']).default('PLANNED'),
    remarks: s.nullableStr(255),
  }).parse(req.body);

  const r = await query(
    `INSERT INTO trx_shipment_container
      (company_id, shipment_id, container_no, container_type, seal_no, tare_weight_kg,
       net_weight_kg, gross_weight_kg, max_cbm, loaded_cbm, stuffing_date, stuffing_location, status, remarks)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, shipmentId, body.container_no, body.container_type, body.seal_no ?? null,
     body.tare_weight_kg ?? null, body.net_weight_kg ?? null, body.gross_weight_kg ?? null,
     body.max_cbm ?? null, body.loaded_cbm ?? null, body.stuffing_date ?? null,
     body.stuffing_location ?? null, body.status, body.remarks ?? null]);

  res.status(201).json({ data: { id: (r as any).insertId } });
}));


// ============================================================
// SHIPMENT LIFECYCLE ACTIONS
// ============================================================

/** POST /shipments/:id/ready-to-dispatch */
shipmentRouter.post('/shipments/:id/ready-to-dispatch', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);

  const ship = await queryOne<any>(`SELECT * FROM trx_shipment WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!ship) throw NotFound('Shipment not found');

  const pkgCount = await queryOne<any>(
    `SELECT COUNT(*) AS c FROM trx_shipment_package WHERE shipment_id = ? AND status != 'CANCELLED'`, [id]);
  if (!pkgCount?.c) throw BadRequest('Cannot release shipment without allocated packages');

  await query(`UPDATE trx_shipment SET tracking_status = 'BOOKED' WHERE id = ?`, [id]);
  res.json({ data: { id, status: 'READY_TO_DISPATCH' } });
}));

/** POST /shipments/:id/tracking — Add tracking event */
shipmentRouter.post('/shipments/:id/tracking', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({
    event_type: s.strReq(60),
    event_location: s.nullableStr(120),
    remarks: s.nullableStr(255),
  }).parse(req.body);

  await transaction(async (tx) => {
    await txExecute(tx,
      `INSERT INTO trx_shipment_event (shipment_id, event_type, event_location, remarks)
       VALUES (?,?,?,?)`,
      [id, body.event_type, body.event_location ?? null, body.remarks ?? null]);

    // Update tracking status on shipment
    if (['GATED_IN','LOADED','SAILED','TRANSIT','ARRIVED','DELIVERED'].includes(body.event_type)) {
      await txExecute(tx, `UPDATE trx_shipment SET tracking_status = ? WHERE id = ?`, [body.event_type, id]);
    }
  });

  res.status(201).json({ data: { shipment_id: id, event: body.event_type } });
}));

/** POST /shipments/:id/delivery — Confirm POD & delivery */
shipmentRouter.post('/shipments/:id/delivery', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({
    delivered_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    receiver_name: s.strReq(80),
    pod_ref: s.nullableStr(60),
    remarks: s.text(),
  }).parse(req.body);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_shipment SET tracking_status = 'DELIVERED', ata = ? WHERE id = ?`,
      [body.delivered_date, id]);

    await txExecute(tx,
      `UPDATE trx_shipment_package SET status = 'DELIVERED' WHERE shipment_id = ?`, [id]);

    await txExecute(tx,
      `UPDATE trx_dispatch SET delivered_date = ?, receiver_name = ?, pod_ref = ? WHERE shipment_id = ?`,
      [body.delivered_date, body.receiver_name, body.pod_ref ?? null, id]);
  });

  res.json({ data: { id, status: 'DELIVERED' } });
}));

/** POST /shipments/:id/cancel — Cancel draft shipment & release packages */
shipmentRouter.post('/shipments/:id/cancel', requirePermission('PACKING.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);

  const ship = await queryOne<any>(`SELECT * FROM trx_shipment WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!ship) throw NotFound('Shipment not found');

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_shipment_package SET status = 'CANCELLED' WHERE shipment_id = ?`, [id]);
    await txExecute(tx,
      `UPDATE trx_shipment SET tracking_status = 'BOOKED', remarks = CONCAT(COALESCE(remarks,''), ' [CANCELLED]') WHERE id = ?`, [id]);
  });

  res.json({ data: { id, status: 'CANCELLED' } });
}));

