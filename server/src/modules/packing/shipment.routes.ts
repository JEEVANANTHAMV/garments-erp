import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  PL_TYPES, blockSchema, computePackingList, normaliseSizeHeaders, groupCartons, type ComputedList,
} from './packingListCalc.js';
import {
  asJson, loadStructure, writeStructure, buildSummary, companyExporterDetails, partyAddressBlock,
} from './packingList.service.js';
import { buildPackingListWorkbook } from './packingListExcel.js';

export const shipmentRouter = Router();

// ============================================================
// PACKING LIST — ASSORTED / SOLID / MIXED (client packinglist.xlsx)
//   header (export document fields) → blocks → carton rows → items
//   All totals are computed server-side (packingListCalc.ts).
// ============================================================

const plDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const packingListSchema = z.object({
  pl_no: s.nullableStr(40),
  pl_date: plDate,
  io_no: s.nullableStr(40),
  so_id: s.id(),
  packing_id: s.id(),
  invoice_id: s.id(),
  buyer_id: s.id(),
  consignee_id: s.id(),
  shipment_type: z.enum(['DOMESTIC', 'EXPORT']).default('DOMESTIC'),
  destination: s.nullableStr(120),
  pl_type: z.enum(PL_TYPES).default('ASSORTED'),
  size_headers: z.array(z.string().trim().max(20)).max(40).nullish(),
  allow_ctn_gaps: z.coerce.boolean().default(false),
  carton_tare_kg: z.union([z.coerce.number().min(0).max(100), z.literal(''), z.null()])
    .transform((v) => (v === '' || v == null ? null : v)).nullish(),
  // export document header
  invoice_no: s.nullableStr(60),
  invoice_date: s.date(),
  buyer_order_no: s.nullableStr(80),
  buyer_order_date: s.date(),
  other_references: s.nullableStr(500),
  exporter_details: s.nullableStr(2000),
  consignee_details: s.nullableStr(2000),
  notify_label: s.nullableStr(40),
  notify_details: s.nullableStr(2000),
  country_of_origin: s.nullableStr(60),
  country_of_destination: s.nullableStr(60),
  pre_carriage_by: s.nullableStr(80),
  place_of_receipt: s.nullableStr(80),
  vessel_flight_no: s.nullableStr(80),
  port_of_loading: s.nullableStr(80),
  port_of_discharge: s.nullableStr(80),
  final_destination: s.nullableStr(80),
  terms_of_delivery: s.nullableStr(500),
  terms_of_payment: s.nullableStr(500),
  remarks: s.text(),
  // carton rows
  blocks: z.array(blockSchema).max(200).default([]),
  manual_order_qty: z.array(z.object({
    group_key: z.string().trim().min(1).max(300),
    size_label: z.string().trim().min(1).max(20),
    order_qty: z.coerce.number().int().min(0),
  })).max(5000).nullish(),
});
type PackingListBody = z.infer<typeof packingListSchema>;

const HEADER_COLS = [
  'pl_date', 'io_no', 'so_id', 'packing_id', 'invoice_id', 'buyer_id', 'consignee_id', 'shipment_type',
  'destination', 'pl_type', 'allow_ctn_gaps', 'carton_tare_kg', 'invoice_no', 'invoice_date', 'buyer_order_no',
  'buyer_order_date', 'other_references', 'exporter_details', 'consignee_details', 'notify_label', 'notify_details',
  'country_of_origin', 'country_of_destination', 'pre_carriage_by', 'place_of_receipt', 'vessel_flight_no',
  'port_of_loading', 'port_of_discharge', 'final_destination', 'terms_of_delivery', 'terms_of_payment', 'remarks',
] as const;

const plId = (raw: unknown) => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid packing list id');
  return id;
};

/** Every referenced record must belong to the caller's company. */
async function assertRefs(cid: number, b: PackingListBody) {
  const checks: [unknown, string, string][] = [
    [b.so_id, 'trx_sales_order', 'Sales order'], [b.packing_id, 'trx_packing', 'Packing'],
    [b.invoice_id, 'trx_commercial_invoice', 'Commercial invoice'], [b.buyer_id, 'mst_party', 'Buyer'],
    [b.consignee_id, 'mst_party', 'Consignee'],
  ];
  for (const [id, table, label] of checks) {
    if (!id) continue;
    const r = await queryOne(`SELECT id FROM ${table} WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!r) throw BadRequest(`${label} #${id} not found`);
  }
  const soIds = new Set<number>(), styleIds = new Set<number>(), colorIds = new Set<number>();
  for (const bl of b.blocks) for (const r of bl.rows) for (const it of r.items) {
    if (it.so_id) soIds.add(it.so_id);
    if (it.style_id) styleIds.add(it.style_id);
    if (it.color_id) colorIds.add(it.color_id);
  }
  for (const [ids, table, label] of [[soIds, 'trx_sales_order', 'Sales order'], [styleIds, 'mst_style', 'Style'], [colorIds, 'mst_color', 'Colour']] as const) {
    if (!ids.size) continue;
    const found = await query<any>(`SELECT id FROM ${table} WHERE company_id = ? AND id IN (${[...ids].map(() => '?').join(',')})`, [cid, ...ids]);
    if (found.length !== ids.size) throw BadRequest(`${label} reference on a carton row does not exist`);
  }
}

/** Validate + compute the carton rows of a request body. */
function computeBody(b: PackingListBody) {
  const blocks = b.blocks.filter((bl) => bl.rows.length);
  let headers = (b.size_headers ?? []).map((x) => x.trim()).filter(Boolean);
  if (!headers.length) {
    // derive from the quantities entered, in first-seen order
    for (const bl of blocks) for (const h of bl.size_headers ?? []) if (!headers.includes(h)) headers.push(h);
    for (const bl of blocks) for (const r of bl.rows) for (const it of r.items)
      for (const [k, v] of Object.entries(it.size_qty)) if (v > 0 && !headers.includes(k)) headers.push(k);
  }
  if (!blocks.length) return { headers: headers.length ? normaliseSizeHeaders(headers, 'Size headers') : null, computed: null };
  const computed = computePackingList({ pl_type: b.pl_type, size_headers: headers, allow_ctn_gaps: b.allow_ctn_gaps, blocks });
  return { headers: normaliseSizeHeaders(headers, 'Size headers'), computed };
}

/** Header totals: from the carton rows, or (legacy lists without rows) from the linked packing. */
async function headerTotals(tx: any, b: PackingListBody, computed: ComputedList | null) {
  if (computed) {
    const t = computed.totals;
    const styles = [...new Set(computed.blocks.flatMap((bl) => bl.rows.flatMap((r) => r.items.map((i) => i.style_no || i.style_name)).filter(Boolean)))];
    return { total_cartons: t.total_cartons, total_qty: t.total_qty, net_weight_kg: t.total_net_wt,
             gross_weight_kg: t.total_gross_wt, total_cbm: t.total_cbm, style_summary: styles.join(', ').slice(0, 5000) || null };
  }
  let out = { total_cartons: 0, total_qty: 0, net_weight_kg: 0, gross_weight_kg: 0, total_cbm: 0, style_summary: null as string | null };
  if (b.packing_id) {
    const agg = await txQueryOne<any>(tx, `SELECT total_cartons, total_qty, net_weight_kg, gross_weight_kg FROM trx_packing WHERE id = ?`, [b.packing_id]);
    const cbm = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(cbm),0) AS c FROM trx_carton WHERE packing_id = ?`, [b.packing_id]);
    out = { ...out, total_cartons: Number(agg?.total_cartons || 0), total_qty: Number(agg?.total_qty || 0),
            net_weight_kg: Number(agg?.net_weight_kg || 0), gross_weight_kg: Number(agg?.gross_weight_kg || 0), total_cbm: Number(cbm?.c || 0) };
  }
  return out;
}

async function writeManualOrderQty(tx: any, cid: number, id: number, rows: PackingListBody['manual_order_qty']) {
  if (rows == null) return;               // not sent → keep what is stored
  await txExecute(tx, `DELETE FROM trx_packing_list_order_qty WHERE packing_list_id = ?`, [id]);
  const merged = new Map<string, { group_key: string; size_label: string; order_qty: number }>();
  for (const r of rows) {
    if (!r.order_qty) continue;
    const k = `${r.group_key}\u0000${r.size_label.toUpperCase()}`;
    const m = merged.get(k);
    if (m) m.order_qty += r.order_qty; else merged.set(k, { ...r });
  }
  for (const r of merged.values()) {
    await txExecute(tx,
      `INSERT INTO trx_packing_list_order_qty (company_id, packing_list_id, group_key, size_label, order_qty) VALUES (?,?,?,?,?)`,
      [cid, id, r.group_key, r.size_label, r.order_qty]);
  }
}

const headerValues = (b: PackingListBody) => HEADER_COLS.map((k) => {
  const v = (b as any)[k];
  if (k === 'allow_ctn_gaps') return v ? 1 : 0;
  return v === undefined ? null : v;
});

/** Full packing list payload: header, blocks/rows/items, totals, summary, legacy carton view. */
async function loadPackingList(cid: number, id: number) {
  const row = await queryOne<any>(
    `SELECT pl.*, p.pack_no, so.so_no, so.buyer_po_no AS so_buyer_po_no,
            b.party_name AS buyer_name, con.party_name AS consignee_name, ci.invoice_no AS ci_invoice_no,
            cu.full_name AS confirmed_by_name
       FROM trx_packing_list pl
       LEFT JOIN trx_packing p ON p.id = pl.packing_id
       LEFT JOIN trx_sales_order so ON so.id = pl.so_id
       LEFT JOIN mst_party b ON b.id = pl.buyer_id
       LEFT JOIN mst_party con ON con.id = pl.consignee_id
       LEFT JOIN trx_commercial_invoice ci ON ci.id = pl.invoice_id
       LEFT JOIN mst_user cu ON cu.id = pl.confirmed_by
      WHERE pl.id = ? AND pl.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Packing list not found');
  row.size_headers = asJson<string[] | null>(row.size_headers, null);
  row.allow_ctn_gaps = Boolean(row.allow_ctn_gaps);

  const structure = await loadStructure(id, row.size_headers);
  const summary = await buildSummary(cid, id, row.so_id ? Number(row.so_id) : null, structure);

  // physical cartons of the linked packing (legacy view + "build rows from cartons")
  let cartons: any[] = [];
  let cartonSummary: any[] = [];
  if (row.packing_id) {
    cartons = await query(
      `SELECT c.*, GROUP_CONCAT(CONCAT(sz.size_code, ':', cc.qty) ORDER BY sz.sort_order SEPARATOR ', ') AS size_summary
         FROM trx_carton c
         JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
         LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
         LEFT JOIN mst_style_sku k ON k.id = cc.sku_id
         LEFT JOIN mst_size sz ON sz.id = k.size_id
        WHERE c.packing_id = ?
        GROUP BY c.id ORDER BY c.carton_no`, [cid, row.packing_id]);
    cartonSummary = await query(
      `SELECT col.color_name, sz.size_code, sz.sort_order, SUM(cc.qty) AS total_qty
         FROM trx_carton_content cc
         JOIN trx_carton c ON c.id = cc.carton_id
         JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
         JOIN mst_style_sku k ON k.id = cc.sku_id
         JOIN mst_color col ON col.id = k.color_id
         JOIN mst_size sz ON sz.id = k.size_id
        WHERE c.packing_id = ?
        GROUP BY col.color_name, sz.size_code, sz.sort_order
        ORDER BY col.color_name, sz.sort_order`, [cid, row.packing_id]);
  }
  return { ...row, blocks: structure.blocks, totals: structure.totals, measurements: structure.measurements,
           order_summary: summary, cartons, summary: cartonSummary };
}

/** GET /packing-lists — All packing lists */
shipmentRouter.get('/packing-lists', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT pl.id, pl.pl_no, pl.pl_date, pl.io_no, pl.so_id, pl.packing_id, pl.invoice_id, pl.buyer_id,
            pl.consignee_id, pl.shipment_type, pl.destination, pl.status, pl.pl_type, pl.total_cartons,
            pl.total_qty, pl.net_weight_kg, pl.gross_weight_kg, pl.total_cbm, pl.invoice_no, pl.buyer_order_no,
            pl.style_summary, pl.created_at, pl.confirmed_at,
            p.pack_no, so.so_no, b.party_name AS buyer_name, con.party_name AS consignee_name,
            (SELECT COUNT(*) FROM trx_packing_list_row r WHERE r.packing_list_id = pl.id) AS row_count
       FROM trx_packing_list pl
       LEFT JOIN trx_packing p ON p.id = pl.packing_id
       LEFT JOIN trx_sales_order so ON so.id = pl.so_id
       LEFT JOIN mst_party b ON b.id = pl.buyer_id
       LEFT JOIN mst_party con ON con.id = pl.consignee_id
      WHERE pl.company_id = ?
      ORDER BY pl.pl_date DESC, pl.id DESC`, [cid]);
  res.json({ data: rows });
}));

/**
 * GET /packing-lists/prefill?so_id=&style_id= — defaults for a new list:
 * exporter block from the company, buyer order / consignee / ports from the
 * sales order, and size-header presets from the size groups of its styles.
 */
shipmentRouter.get('/packing-lists/prefill', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = req.query.so_id ? Number(req.query.so_id) : null;
  const styleId = req.query.style_id ? Number(req.query.style_id) : null;
  const out: any = { exporter_details: await companyExporterDetails(cid), country_of_origin: 'INDIA' };

  const groupIds = new Set<number>();
  if (soId) {
    const so = await queryOne<any>(
      `SELECT so.id, so.so_no, so.io_no, so.buyer_id, so.buyer_po_no, so.buyer_po_date, so.port_of_loading,
              so.destination_port, so.incoterm, so.payment_term, so.lc_no, so.lc_date, so.order_type, ct.name AS dest_country
         FROM trx_sales_order so LEFT JOIN cfg_country ct ON ct.id = so.destination_country
        WHERE so.id = ? AND so.company_id = ?`, [soId, cid]);
    if (!so) throw NotFound('Sales order not found');
    Object.assign(out, {
      so_id: so.id, io_no: so.io_no, buyer_id: so.buyer_id, consignee_id: so.buyer_id,
      buyer_order_no: so.buyer_po_no, buyer_order_date: so.buyer_po_date ? String(so.buyer_po_date instanceof Date ? so.buyer_po_date.toISOString() : so.buyer_po_date).slice(0, 10) : null,
      port_of_loading: so.port_of_loading, port_of_discharge: so.destination_port,
      country_of_destination: so.dest_country ? String(so.dest_country).toUpperCase() : null,
      final_destination: so.dest_country ? String(so.dest_country).toUpperCase() : null,
      terms_of_delivery: so.incoterm ?? null,
      terms_of_payment: [so.payment_term, so.lc_no ? `L/C NO: ${so.lc_no}` : null].filter(Boolean).join(' ') || null,
      shipment_type: so.order_type === 'EXPORT' ? 'EXPORT' : 'DOMESTIC',
      consignee_details: await partyAddressBlock(cid, so.buyer_id),
    });
    const lines = await query<any>(
      `SELECT DISTINCT l.style_id, st.style_code, st.style_name, st.size_group_id, col.color_name, l.color_id
         FROM trx_sales_order_line l LEFT JOIN mst_style st ON st.id = l.style_id
         LEFT JOIN mst_color col ON col.id = l.color_id WHERE l.so_id = ?`, [soId]);
    out.styles = lines;
    for (const l of lines) if (l.size_group_id) groupIds.add(Number(l.size_group_id));
  }
  if (styleId) {
    const st = await queryOne<any>(`SELECT size_group_id FROM mst_style WHERE id = ? AND company_id = ?`, [styleId, cid]);
    if (st?.size_group_id) groupIds.add(Number(st.size_group_id));
  }
  const presets: { name: string; sizes: string[]; source: string }[] = [];
  if (groupIds.size) {
    const sizes = await query<any>(
      `SELECT g.id, g.group_name, s.size_code FROM mst_size_group g JOIN mst_size s ON s.size_group_id = g.id AND s.is_active = 1
        WHERE g.company_id = ? AND g.id IN (${[...groupIds].map(() => '?').join(',')}) ORDER BY g.id, s.sort_order`,
      [cid, ...groupIds]);
    const byGroup = new Map<number, { name: string; sizes: string[] }>();
    for (const s2 of sizes) {
      const g = byGroup.get(s2.id) ?? { name: String(s2.group_name), sizes: [] as string[] };
      g.sizes.push(s2.size_code); byGroup.set(s2.id, g);
    }
    for (const g of byGroup.values()) presets.push({ ...g, source: 'STYLE' });
  }
  presets.push(
    { name: 'Alpha S – XXXL', sizes: ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'], source: 'STANDARD' },
    { name: 'Numeric 36 – 52', sizes: ['36', '38', '40', '42', '44', '46', '48', '50', '52'], source: 'STANDARD' },
    { name: 'Kids 3A – 14A + Adult S – XXL', sizes: ['3A', '4A', '6A', '8A', '10A', '12A', '14A', 'S', 'M', 'L', 'XL', 'XXL'], source: 'STANDARD' },
    { name: 'Kids 3A – 14A', sizes: ['3A', '4A', '6A', '8A', '10A', '12A', '14A'], source: 'STANDARD' },
    { name: 'Women 1 – 5', sizes: ['1', '2', '3', '4', '5'], source: 'STANDARD' },
  );
  out.size_presets = presets;
  res.json({ data: out });
}));

/**
 * GET /packing-lists/build-rows?packing_id= — carton rows built from the
 * physical cartons of a packing: identical consecutive cartons become one
 * carton-number range. Preview only; the user saves the list afterwards.
 */
shipmentRouter.get('/packing-lists/build-rows', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const packingId = Number(req.query.packing_id);
  if (!Number.isInteger(packingId) || packingId <= 0) throw BadRequest('packing_id is required');
  const packing = await queryOne<any>(
    `SELECT p.id, p.so_id, so.buyer_po_no, so.so_no FROM trx_packing p LEFT JOIN trx_sales_order so ON so.id = p.so_id
      WHERE p.id = ? AND p.company_id = ?`, [packingId, cid]);
  if (!packing) throw NotFound('Packing record not found');
  const cartons = await query<any>(
    `SELECT id, carton_no, net_weight_kg, gross_weight_kg, length_cm, width_cm, height_cm FROM trx_carton WHERE packing_id = ?`, [packingId]);
  if (!cartons.length) throw BadRequest('This packing has no cartons yet');
  const contents = await query<any>(
    `SELECT cc.carton_id, k.style_id, st.style_code, st.style_name, k.color_id, col.color_name, sz.size_code, sz.sort_order, cc.qty
       FROM trx_carton_content cc
       JOIN trx_carton c ON c.id = cc.carton_id
       JOIN mst_style_sku k ON k.id = cc.sku_id
       JOIN mst_style st ON st.id = k.style_id
       JOIN mst_color col ON col.id = k.color_id
       JOIN mst_size sz ON sz.id = k.size_id
      WHERE c.packing_id = ? ORDER BY sz.sort_order`, [packingId]);
  const sizeOrder: string[] = [];
  for (const x of [...contents].sort((a, b) => a.sort_order - b.sort_order)) if (!sizeOrder.includes(x.size_code)) sizeOrder.push(x.size_code);
  const byCarton = new Map<number, any[]>();
  for (const x of contents) { const a = byCarton.get(x.carton_id) ?? []; a.push(x); byCarton.set(x.carton_id, a); }
  const rows = groupCartons(cartons.map((c: any) => ({ ...c, contents: byCarton.get(c.id) ?? [] }))
    .filter((c: any) => c.contents.length), packing.buyer_po_no ?? packing.so_no ?? null, packing.so_id ?? null);
  const empty = cartons.length - rows.reduce((a, r) => a + r.no_of_ctns, 0);
  const types = new Set(rows.map((r) => (r.items.length > 1 ? 'MIXED' : Object.keys(r.items[0].size_qty).length === 1 ? 'SOLID' : 'ASSORTED')));
  const plType = types.has('MIXED') ? 'MIXED' : types.size === 1 && types.has('SOLID') ? 'SOLID' : types.has('ASSORTED') && types.has('SOLID') ? 'ASSORTED' : [...types][0] ?? 'ASSORTED';
  res.json({ data: { size_headers: sizeOrder, pl_type: plType, blocks: [{ label: null, size_headers: null, rows }], empty_cartons: empty } });
}));

/** GET /packing-lists/:id — header + carton rows + totals + Order/Shipped/Diff summary */
shipmentRouter.get('/packing-lists/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  res.json({ data: await loadPackingList(req.user!.companyId, plId(req.params.id)) });
}));

/** POST /packing-lists/preview — validate & compute without saving (live totals / errors). */
shipmentRouter.post('/packing-lists/preview', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const body = packingListSchema.parse(req.body);
  const { headers, computed } = computeBody(body);
  const summary = computed ? await buildSummary(req.user!.companyId, null, body.so_id ?? null, computed, body.manual_order_qty ?? []) : [];
  res.json({ data: { size_headers: headers, ...(computed ?? { blocks: [], totals: null, measurements: [], warnings: [] }), order_summary: summary } });
}));

/** POST /packing-lists — Create packing list (always DRAFT) with its carton rows */
shipmentRouter.post('/packing-lists', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = packingListSchema.parse(req.body);
  await assertRefs(cid, body);
  const { headers, computed } = computeBody(body);
  if (!body.exporter_details) body.exporter_details = await companyExporterDetails(cid);

  const id = await transaction(async (tx) => {
    const plNo = body.pl_no || await nextDocNumber(tx, cid, 'PACKING_LIST');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_packing_list WHERE company_id = ? AND pl_no = ?`, [cid, plNo]);
    if (dup) throw BadRequest(`Packing list number "${plNo}" already exists`);
    const t = await headerTotals(tx, body, computed);
    const r = await txExecute(tx,
      `INSERT INTO trx_packing_list
         (company_id, pl_no, ${HEADER_COLS.join(', ')}, size_headers, status,
          total_cartons, total_qty, net_weight_kg, gross_weight_kg, total_cbm, style_summary, created_by)
       VALUES (?,?,${HEADER_COLS.map(() => '?').join(',')},?,'DRAFT',?,?,?,?,?,?,?)`,
      [cid, plNo, ...headerValues(body), headers ? JSON.stringify(headers) : null,
       t.total_cartons, t.total_qty, t.net_weight_kg, t.gross_weight_kg, t.total_cbm, t.style_summary, req.user!.id]);
    if (computed) await writeStructure(tx, cid, r.insertId, computed);
    await writeManualOrderQty(tx, cid, r.insertId, body.manual_order_qty);
    return r.insertId;
  });

  const data = await loadPackingList(cid, id);
  await audit(req, 'trx_packing_list', id, 'INSERT', undefined, { header: body, totals: data.totals });
  res.status(201).json({ data, warnings: computed?.warnings ?? [] });
}));

/** PUT /packing-lists/:id — Update header + replace carton rows (DRAFT only) */
shipmentRouter.put('/packing-lists/:id', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = plId(req.params.id);
  const body = packingListSchema.parse(req.body);
  await assertRefs(cid, body);
  const { headers, computed } = computeBody(body);

  const before = await transaction(async (tx) => {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pl) throw NotFound('Packing list not found');
    if (pl.status !== 'DRAFT') throw BadRequest(`Packing list ${pl.pl_no} is ${pl.status} and can no longer be edited`);
    if (body.pl_no && body.pl_no !== pl.pl_no) {
      const dup = await txQueryOne(tx, `SELECT id FROM trx_packing_list WHERE company_id = ? AND pl_no = ? AND id <> ?`, [cid, body.pl_no, id]);
      if (dup) throw BadRequest(`Packing list number "${body.pl_no}" already exists`);
    }
    const t = await headerTotals(tx, body, computed);
    await txExecute(tx,
      `UPDATE trx_packing_list SET pl_no = ?, ${HEADER_COLS.map((c) => `${c} = ?`).join(', ')}, size_headers = ?,
              total_cartons = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?, total_cbm = ?, style_summary = ?,
              updated_by = ?, updated_at = NOW()
        WHERE id = ?`,
      [body.pl_no || pl.pl_no, ...headerValues(body), headers ? JSON.stringify(headers) : null,
       t.total_cartons, t.total_qty, t.net_weight_kg, t.gross_weight_kg, t.total_cbm, t.style_summary, req.user!.id, id]);
    if (computed) await writeStructure(tx, cid, id, computed);
    else {
      await txExecute(tx, `DELETE FROM trx_packing_list_row_item WHERE packing_list_id = ?`, [id]);
      await txExecute(tx, `DELETE FROM trx_packing_list_row WHERE packing_list_id = ?`, [id]);
      await txExecute(tx, `DELETE FROM trx_packing_list_block WHERE packing_list_id = ?`, [id]);
    }
    await writeManualOrderQty(tx, cid, id, body.manual_order_qty);
    return pl;
  });

  const data = await loadPackingList(cid, id);
  await audit(req, 'trx_packing_list', id, 'UPDATE',
    { total_cartons: before.total_cartons, total_qty: before.total_qty, gross_weight_kg: before.gross_weight_kg },
    { header: { ...body, blocks: undefined }, totals: data.totals });
  res.json({ data, warnings: computed?.warnings ?? [] });
}));

/** POST /packing-lists/:id/confirm — Validate completeness, then freeze */
shipmentRouter.post('/packing-lists/:id/confirm', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = plId(req.params.id);
  await transaction(async (tx) => {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pl) throw NotFound('Packing list not found');
    if (pl.status !== 'DRAFT') throw BadRequest(`Packing list is already ${pl.status}`);
    const st = await loadStructure(id, asJson(pl.size_headers, null), { tx });
    const rows = st.blocks.flatMap((b) => b.rows);
    if (!rows.length && !pl.packing_id) throw BadRequest('Add carton rows (or link a packing) before confirming');
    const noWeight = rows.filter((r) => !r.gross_wt_per_ctn);
    if (noWeight.length) throw BadRequest(`Gross weight per carton is missing on cartons ${noWeight.map((r) => `${r.ctn_from}-${r.ctn_to}`).join(', ')}`);
    // rows built from physical cartons must still match them (a draft carton may have been deleted since)
    const srcIds = [...new Set(rows.flatMap((r) => r.source_carton_ids ?? []))];
    if (srcIds.length) {
      const found = await txQueryOne<any>(tx,
        `SELECT COUNT(*) AS n FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
          WHERE c.id IN (${srcIds.map(() => '?').join(',')})`, [cid, ...srcIds]);
      if (Number(found?.n || 0) !== srcIds.length)
        throw BadRequest(`${srcIds.length - Number(found?.n || 0)} carton(s) these rows were built from no longer exist; rebuild the rows from the packing before confirming`);
    }
    await txExecute(tx, `UPDATE trx_packing_list SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'trx_packing_list', id, 'UPDATE', { status: pl.status }, { status: 'CONFIRMED', totals: st.totals }, tx);
  });
  res.json({ data: await loadPackingList(cid, id) });
}));

/**
 * POST /packing-lists/:id/reopen — back to DRAFT for correction, with a reason.
 * Needs PACKING.DELETE (the strongest packing right) and is refused once a
 * live shipment references the list.
 */
shipmentRouter.post('/packing-lists/:id/reopen', requirePermission('PACKING.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = plId(req.params.id);
  const { reason } = z.object({ reason: s.strReq(255) }).parse(req.body);
  await transaction(async (tx) => {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pl) throw NotFound('Packing list not found');
    if (pl.status !== 'CONFIRMED') throw BadRequest(`Only a CONFIRMED packing list can be re-opened (this one is ${pl.status})`);
    const ship = await txQueryOne<any>(tx,
      `SELECT shipment_no FROM trx_shipment WHERE packing_list_id = ? AND company_id = ?
          AND COALESCE(remarks,'') NOT LIKE '%[CANCELLED]%' LIMIT 1`, [id, cid]);
    if (ship) throw BadRequest(`Packing list is used by shipment ${ship.shipment_no}; cancel the shipment first`);
    await txExecute(tx, `UPDATE trx_packing_list SET status = 'DRAFT', reopen_reason = ?, confirmed_by = NULL, confirmed_at = NULL,
                            updated_by = ?, updated_at = NOW() WHERE id = ?`, [reason, req.user!.id, id]);
    await audit(req, 'trx_packing_list', id, 'UPDATE', { status: 'CONFIRMED' }, { status: 'DRAFT', reopen_reason: reason }, tx);
  });
  res.json({ data: await loadPackingList(cid, id) });
}));

/** GET /packing-lists/:id/export.xlsx — Excel in the client's layout for the list's type */
shipmentRouter.get('/packing-lists/:id/export.xlsx', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const pl = await loadPackingList(cid, plId(req.params.id));
  const structure: ComputedList = { blocks: pl.blocks, totals: pl.totals, measurements: pl.measurements, warnings: [] };
  if (!structure.blocks.length) throw BadRequest('This packing list has no carton rows to export');
  const iso = (d: any) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null);
  const buf = buildPackingListWorkbook({
    ...pl, invoice_no: pl.invoice_no ?? pl.ci_invoice_no ?? null,
    invoice_date: iso(pl.invoice_date), buyer_order_date: iso(pl.buyer_order_date),
  }, structure, pl.order_summary);
  const fname = `${String(pl.pl_no).replace(/[^A-Za-z0-9_-]+/g, '_')}_${pl.pl_type}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
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
shipmentRouter.post('/shipments/:id/allocate-packages', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/documents', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/containers', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/ready-to-dispatch', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/tracking', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/delivery', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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
shipmentRouter.post('/shipments/:id/cancel', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
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

