import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  PL_TYPES, blockSchema, computePackingList, normaliseSizeHeaders, buildFormatBlocks, type ComputedList, type PlType,
} from './packingListCalc.js';
import {
  asJson, loadStructure, writeStructure, buildSummary, companyExporterDetails, partyAddressBlock,
} from './packingList.service.js';
import { buildPackingListWorkbook, buildPackingListLayout } from './packingListExcel.js';

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
  ctn_numbering: z.enum(['SEQUENCE', 'CARTON_NO']).default('SEQUENCE'),
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
  'destination', 'pl_type', 'ctn_numbering', 'allow_ctn_gaps', 'carton_tare_kg', 'invoice_no', 'invoice_date', 'buyer_order_no',
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

/* ------------------------------------------------------------------
   Posted cartons (packing engine contract, db/118):
   READY = posted and verified / sealed; dispatch sets DISPATCHED.
   A carton sits on at most one packing list (trx_packing_list_carton)
   and on at most one active shipment (trx_shipment_package not CANCELLED).
------------------------------------------------------------------ */
const READY_SQL = `c.is_posted = 1 AND c.carton_status IN ('VERIFIED','SEALED')`;
const ACTIVE_SHIP_SQL = `COALESCE(sh.remarks,'') NOT LIKE '%[CANCELLED]%'`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r5 = (n: number) => Math.round(n * 100000) / 100000;

/** Content qty of each carton (one query). */
async function cartonQtyMap(db: { tx?: any }, ids: number[]) {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const sql = `SELECT carton_id, COALESCE(SUM(qty),0) AS q FROM trx_carton_content WHERE carton_id IN (?) GROUP BY carton_id`;
  const rows = db.tx ? await txQuery<any>(db.tx, sql, [ids]) : await query<any>(sql, [ids]);
  for (const r of rows) out.set(Number(r.carton_id), Number(r.q));
  return out;
}

/** Carton facts the editor shows next to rows built from cartons, keyed by carton id. */
async function cartonInfo(cid: number, ids: number[]) {
  const info: Record<number, any> = {};
  if (!ids.length) return info;
  const rows = await query<any>(
    `SELECT c.id, c.carton_no, c.carton_status, c.is_posted, c.is_partial, c.polybag_qty, c.pieces_total,
            c.net_weight_kg, c.gross_weight_kg, c.cbm, p.pack_no, COALESCE(SUM(cc.qty),0) AS qty
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
       LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
      WHERE c.id IN (?) GROUP BY c.id`, [cid, ids]);
  for (const r of rows) info[r.id] = {
    carton_no: r.carton_no, pack_no: r.pack_no, status: r.carton_status, is_posted: Boolean(r.is_posted),
    is_partial: Boolean(r.is_partial), polybag_qty: Number(r.polybag_qty || 0), qty: Number(r.qty || 0),
    net_weight_kg: r.net_weight_kg == null ? null : Number(r.net_weight_kg),
    gross_weight_kg: r.gross_weight_kg == null ? null : Number(r.gross_weight_kg), cbm: r.cbm == null ? null : Number(r.cbm),
  };
  return info;
}

const cartonAgg = (rows: { qty: number; polybag_qty: number; is_partial: boolean }[]) => ({
  cartons: rows.length, qty: rows.reduce((a, r) => a + r.qty, 0),
  polybags: rows.reduce((a, r) => a + r.polybag_qty, 0),
  partial: rows.filter((r) => r.is_partial).length, full: rows.filter((r) => !r.is_partial).length,
});

/**
 * Header panel: Order qty | Packed (posted cartons) | On this list | Balance,
 * full vs partial cartons, polybags, and carton / polybag trim stock.
 */
async function packSummary(cid: number, soId: number | null, ioNo: string | null, plId: number | null) {
  const out: any = { order_qty: null, packed: null, ready_unlisted: null, this_pl: null, balance_to_pack: null, packaging_stock: null };
  if (soId) {
    const o = await queryOne<any>(
      `SELECT COALESCE(SUM(sk.qty),0) AS q FROM trx_sales_order_line l JOIN trx_sales_order so ON so.id = l.so_id AND so.company_id = ?
         JOIN trx_sales_order_sku sk ON sk.so_line_id = l.id WHERE l.so_id = ?`, [cid, soId]);
    out.order_qty = Number(o?.q || 0);
  }
  if (soId || ioNo) {
    const where = soId ? `p.so_id = ?` : `p.io_no = ?`;
    const rows = await query<any>(
      `SELECT c.id, c.carton_status, c.is_partial, c.polybag_qty,
              (SELECT COALESCE(SUM(cc.qty),0) FROM trx_carton_content cc WHERE cc.carton_id = c.id) AS qty,
              (SELECT plc.packing_list_id FROM trx_packing_list_carton plc WHERE plc.carton_id = c.id) AS pl_id
         FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
        WHERE ${where} AND c.is_posted = 1 AND c.carton_status IN ('VERIFIED','SEALED','DISPATCHED')`, [cid, soId ?? ioNo]);
    const norm = rows.map((r: any) => ({ ...r, qty: Number(r.qty), polybag_qty: Number(r.polybag_qty || 0), is_partial: Boolean(r.is_partial) }));
    out.packed = cartonAgg(norm);
    out.ready_unlisted = cartonAgg(norm.filter((r) => r.carton_status !== 'DISPATCHED' && !r.pl_id));
    if (out.order_qty != null) out.balance_to_pack = out.order_qty - out.packed.qty;
  }
  if (plId) {
    const rows = await query<any>(
      `SELECT c.id, c.is_partial, c.polybag_qty, (SELECT COALESCE(SUM(cc.qty),0) FROM trx_carton_content cc WHERE cc.carton_id = c.id) AS qty
         FROM trx_packing_list_carton plc JOIN trx_carton c ON c.id = plc.carton_id
        WHERE plc.packing_list_id = ? AND plc.company_id = ?`, [plId, cid]);
    out.this_pl = cartonAgg(rows.map((r: any) => ({ qty: Number(r.qty), polybag_qty: Number(r.polybag_qty || 0), is_partial: Boolean(r.is_partial) })));
  }
  // packaging trims in stock (carton boxes / polybags): free = stock − allocated; job-specific stock is counted for that job only
  const stock = await query<any>(
    `SELECT t.trim_type, COALESCE(SUM(s2.stock_qty - s2.allocated_qty),0) AS free
       FROM trx_trim_stock s2 JOIN mst_trim t ON t.id = s2.trim_id
      WHERE s2.company_id = ? AND t.trim_type IN ('CARTON','POLYBAG') AND (s2.so_id IS NULL OR s2.so_id = ?)
      GROUP BY t.trim_type`, [cid, soId ?? 0]);
  out.packaging_stock = { CARTON: 0, POLYBAG: 0 };
  for (const s2 of stock) out.packaging_stock[s2.trim_type] = Math.max(0, Number(s2.free));
  return out;
}

/**
 * Keep trx_packing_list_carton in step with the rows' source cartons.
 * Every source carton must be READY and not on another packing list.
 */
async function syncCartonLinks(tx: any, cid: number, plId: number, computed: ComputedList | null) {
  const ids = (computed?.blocks ?? []).flatMap((b) => b.rows.flatMap((r) => r.source_carton_ids ?? []));
  const uniq = [...new Set(ids)];
  if (uniq.length !== ids.length) throw BadRequest('The same carton is used on two rows of this packing list');
  await txExecute(tx, `DELETE FROM trx_packing_list_carton WHERE packing_list_id = ?`, [plId]);
  if (!uniq.length) return;
  const rows = await txQuery<any>(tx,
    `SELECT c.id, c.carton_no, c.is_posted, c.carton_status, plc.packing_list_id AS other_pl, pl.pl_no AS other_pl_no
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
       LEFT JOIN trx_packing_list_carton plc ON plc.carton_id = c.id AND plc.packing_list_id <> ?
       LEFT JOIN trx_packing_list pl ON pl.id = plc.packing_list_id
      WHERE c.id IN (?) FOR UPDATE`, [cid, plId, uniq]);
  if (rows.length !== uniq.length) throw BadRequest(`${uniq.length - rows.length} carton(s) these rows were built from no longer exist; rebuild the rows from the packed cartons`);
  const notReady = rows.filter((r: any) => !(Number(r.is_posted) === 1 && ['VERIFIED', 'SEALED'].includes(r.carton_status)));
  if (notReady.length) throw BadRequest(`Carton(s) ${notReady.map((r: any) => `${r.carton_no} (${r.carton_status}${Number(r.is_posted) ? '' : ', not posted'})`).join(', ')} are not ready — only posted, verified / sealed cartons go on a packing list`);
  const taken = rows.filter((r: any) => r.other_pl);
  if (taken.length) throw BadRequest(`Carton(s) ${taken.map((r: any) => `${r.carton_no} → ${r.other_pl_no}`).join(', ')} are already on another packing list`);
  try {
    await txQuery(tx, `INSERT INTO trx_packing_list_carton (company_id, packing_list_id, carton_id) VALUES ?`, [uniq.map((c) => [cid, plId, c])]);
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') throw BadRequest('A carton on this list was just put on another packing list; rebuild the rows');
    throw e;
  }
}

/** Over-shipment (shipped > order qty) per order / style / colour — shown separately, never as a hidden negative Diff. */
function overShipment(summary: any[]) {
  const lines = summary.filter((g) => g.excess_total > 0).map((g) => ({
    group_key: g.group_key, style: g.style_no || g.style_name, colour: g.colour, excess: g.excess, excess_total: g.excess_total }));
  return { qty: lines.reduce((a, l) => a + l.excess_total, 0), lines };
}

/**
 * Rows built from posted cartons must still match those cartons (spec §8: the packing list
 * is a snapshot; if carton contents change after it was made, it needs a revision).
 */
async function cartonCheck(cid: number, st: ComputedList) {
  const rows = st.blocks.flatMap((b) => b.rows).filter((r) => r.source_carton_ids?.length);
  const ids = [...new Set(rows.flatMap((r) => r.source_carton_ids ?? []))];
  if (!ids.length) return { ok: true, cartons: 0, issues: [] as string[] };
  const cs = await query<any>(
    `SELECT c.id, c.carton_no, c.carton_status, c.is_posted FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
      WHERE c.id IN (?)`, [cid, ids]);
  const byId = new Map(cs.map((c: any) => [Number(c.id), c]));
  const qty = await cartonQtyMap({}, ids);
  const issues: string[] = [];
  const missing = ids.filter((i) => !byId.has(i));
  if (missing.length) issues.push(`${missing.length} carton(s) no longer exist`);
  const voided = cs.filter((c: any) => c.carton_status === 'VOID' || !Number(c.is_posted));
  if (voided.length) issues.push(`carton(s) ${voided.map((c: any) => c.carton_no).join(', ')} are void / un-posted`);
  for (const r of rows) {
    const q = (r.source_carton_ids ?? []).reduce((a, c) => a + (qty.get(c) ?? 0), 0);
    if (q !== r.total_qty) issues.push(`cartons ${r.ctn_from}-${r.ctn_to}: ${r.total_qty} pcs on the list, ${q} pcs in the cartons now`);
  }
  return { ok: !issues.length, cartons: ids.length, issues };
}

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
  // rows built from posted cartons vs rows typed by hand / from the order
  const srcIds = [...new Set(structure.blocks.flatMap((b) => b.rows.flatMap((r) => r.source_carton_ids ?? [])))];
  const allRows = structure.blocks.flatMap((b) => b.rows);
  const handRows = allRows.filter((r) => !r.source_carton_ids?.length).length;
  const ship = await queryOne<any>(
    `SELECT sh.id, sh.shipment_no FROM trx_shipment sh WHERE sh.packing_list_id = ? AND sh.company_id = ? AND ${ACTIVE_SHIP_SQL} LIMIT 1`, [id, cid]);
  const revisions = await query<any>(
    `SELECT r.revision_no, r.reason, r.total_cartons, r.total_qty, r.gross_weight_kg, r.created_at, u.full_name AS created_by_name
       FROM trx_packing_list_revision r LEFT JOIN mst_user u ON u.id = r.created_by
      WHERE r.packing_list_id = ? AND r.company_id = ? ORDER BY r.revision_no DESC`, [id, cid]);
  const iso = (d: any) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null);
  const layout = structure.blocks.length ? buildPackingListLayout({
    ...row, invoice_no: row.invoice_no ?? row.ci_invoice_no ?? null,
    invoice_date: iso(row.invoice_date), buyer_order_date: iso(row.buyer_order_date),
  }, structure, summary) : null;
  return { ...row, blocks: structure.blocks, totals: structure.totals, measurements: structure.measurements,
           order_summary: summary, over_shipment: overShipment(summary), layout, revisions,
           carton_check: await cartonCheck(cid, structure),
           cartons, summary: cartonSummary,
           carton_info: await cartonInfo(cid, srcIds), hand_rows: handRows, carton_rows: allRows.length - handRows,
           source: !allRows.length ? 'NONE' : !handRows ? 'CARTONS' : handRows === allRows.length ? 'MANUAL' : 'MIXED',
           shipment: ship ?? null,
           pack_summary: await packSummary(cid, row.so_id ? Number(row.so_id) : null, row.io_no ?? null, id) };
}

/** GET /packing-lists — All packing lists */
shipmentRouter.get('/packing-lists', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT pl.id, pl.pl_no, pl.pl_date, pl.io_no, pl.so_id, pl.packing_id, pl.invoice_id, pl.buyer_id,
            pl.consignee_id, pl.shipment_type, pl.destination, pl.status, pl.pl_type, pl.total_cartons,
            pl.total_qty, pl.net_weight_kg, pl.gross_weight_kg, pl.total_cbm, pl.invoice_no, pl.buyer_order_no,
            pl.style_summary, pl.created_at, pl.confirmed_at, pl.revision_no, pl.over_ship_note,
            p.pack_no, so.so_no, b.party_name AS buyer_name, con.party_name AS consignee_name,
            (SELECT COUNT(*) FROM trx_packing_list_row r WHERE r.packing_list_id = pl.id) AS row_count,
            (SELECT COUNT(*) FROM trx_packing_list_carton plc WHERE plc.packing_list_id = pl.id) AS linked_cartons,
            (SELECT sh.shipment_no FROM trx_shipment sh WHERE sh.packing_list_id = pl.id AND sh.company_id = pl.company_id
                AND ${ACTIVE_SHIP_SQL} ORDER BY sh.id DESC LIMIT 1) AS shipment_no
       FROM trx_packing_list pl
       LEFT JOIN trx_packing p ON p.id = pl.packing_id
       LEFT JOIN trx_sales_order so ON so.id = pl.so_id
       LEFT JOIN mst_party b ON b.id = pl.buyer_id
       LEFT JOIN mst_party con ON con.id = pl.consignee_id
      WHERE pl.company_id = ?
      ORDER BY pl.pl_date DESC, pl.id DESC`, [cid]);
  // ?for_shipment=1 → only CONFIRMED lists not yet on an active shipment (Shipment / Shipment Planning pickers)
  const forShip = req.query.for_shipment === '1' || req.query.for_shipment === 'true';
  res.json({ data: forShip ? rows.filter((r: any) => r.status === 'CONFIRMED' && !r.shipment_no) : rows });
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
    const isoD = (d: any) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
    const dmyD = (d: any) => { const v = isoD(d); return v ? `${v.slice(8, 10)}.${v.slice(5, 7)}.${v.slice(0, 4)}` : ''; };
    const up = (v: any) => (v ? String(v).toUpperCase() : null);
    // linked commercial invoice and shipment of the order (latest live one), when they exist
    const inv = await queryOne<any>(
      `SELECT ci.id, ci.invoice_no, ci.invoice_date, ci.port_of_loading, ci.port_of_discharge, ci.final_destination, ci.lc_no, ci.incoterm,
              co.name AS origin, cd.name AS dest
         FROM trx_commercial_invoice ci LEFT JOIN cfg_country co ON co.id = ci.country_origin LEFT JOIN cfg_country cd ON cd.id = ci.country_dest
        WHERE ci.so_id = ? AND ci.company_id = ? ORDER BY ci.invoice_date DESC, ci.id DESC LIMIT 1`, [soId, cid]);
    const shp = await queryOne<any>(
      `SELECT sh.id, sh.shipment_no, sh.mode, sh.vessel_name, sh.voyage_no, sh.pol, sh.pod, sh.destination, sh.consignee_id, sh.notify_party_id,
              ct.name AS country
         FROM trx_shipment sh LEFT JOIN cfg_country ct ON ct.id = sh.country_id
        WHERE sh.so_id = ? AND sh.company_id = ? AND ${ACTIVE_SHIP_SQL} ORDER BY sh.id DESC LIMIT 1`, [soId, cid]);
    const mode = shp?.mode ? `BY ${shp.mode}` : null;
    const pod = inv?.port_of_discharge || shp?.pod || so.destination_port || null;
    const destCountry = up(inv?.dest || shp?.country || so.dest_country);
    const incoterm = inv?.incoterm || so.incoterm || null;
    const lcNo = inv?.lc_no || so.lc_no || null;
    Object.assign(out, {
      so_id: so.id, so_no: so.so_no, io_no: so.io_no, buyer_id: so.buyer_id, consignee_id: shp?.consignee_id ?? so.buyer_id,
      buyer_order_no: so.buyer_po_no, buyer_order_date: isoD(so.buyer_po_date),
      invoice_id: inv?.id ?? null, invoice_no: inv?.invoice_no ?? null, invoice_date: isoD(inv?.invoice_date),
      port_of_loading: inv?.port_of_loading || shp?.pol || so.port_of_loading, port_of_discharge: pod,
      country_of_origin: up(inv?.origin) || 'INDIA',
      country_of_destination: destCountry, final_destination: inv?.final_destination || destCountry,
      vessel_flight_no: [mode, shp?.vessel_name, shp?.voyage_no].filter(Boolean).join(' ') || null,
      // as typed on the buyer sheets: "CPT BY AIR -BRUSSELS" / "PAYMENT TERMS: L/C AT SIGHT" / "L/C NO: … DATE: …"
      terms_of_delivery: incoterm ? [incoterm, mode, pod ? `-${up(pod)}` : null].filter(Boolean).join(' ') : null,
      terms_of_payment: [so.payment_term ? `PAYMENT TERMS: ${so.payment_term}` : null,
                         lcNo ? `L/C NO: ${lcNo}${so.lc_date ? ` DATE: ${dmyD(so.lc_date)}` : ''}` : null].filter(Boolean).join('\n') || null,
      other_references: 'STYLE REF NO : AS PER BELOW',
      shipment_type: so.order_type === 'EXPORT' ? 'EXPORT' : 'DOMESTIC',
      shipment_no: shp?.shipment_no ?? null,
      consignee_details: await partyAddressBlock(cid, shp?.consignee_id ?? so.buyer_id),
    });
    if (shp?.notify_party_id) Object.assign(out, { notify_label: 'Notify Party :-', notify_details: await partyAddressBlock(cid, shp.notify_party_id) });
    else {
      // a separate shipping address of the buyer prints as "Goods Delivery address" (solid sheet)
      const ship = await queryOne<any>(
        `SELECT pa.address_name, pa.address_line1, pa.address_line2, pa.address_line3, pa.city, pa.pincode, ct.name AS country
           FROM mst_party_address pa LEFT JOIN cfg_country ct ON ct.id = pa.country_id
          WHERE pa.party_id = ? AND pa.is_active = 1 AND pa.address_type = 'SHIPPING' AND pa.is_default = 0 ORDER BY pa.id LIMIT 1`, [so.buyer_id]);
      if (ship) Object.assign(out, { notify_label: 'Goods Delivery address', notify_details: [ship.address_name, ship.address_line1, ship.address_line2, ship.address_line3,
        [ship.pincode, ship.city].filter(Boolean).join(' '), up(ship.country)].filter(Boolean).join('\n') });
    }
    const lines = await query<any>(
      `SELECT DISTINCT l.style_id, st.style_code, st.style_name, st.size_group_id, col.color_name, l.color_id
         FROM trx_sales_order_line l LEFT JOIN mst_style st ON st.id = l.style_id
         LEFT JOIN mst_color col ON col.id = l.color_id WHERE l.so_id = ?`, [soId]);
    out.styles = lines;
    for (const l of lines) if (l.size_group_id) groupIds.add(Number(l.size_group_id));
    // Style + colour + size qty of the order, for the carton-row pickers and "Add rows from order".
    // The colour sits on the SKU when the order line has none (one line, several colours).
    const skus = await query<any>(
      `SELECT l.style_id, st.style_code, st.style_name, col.id AS color_id, col.color_name, sz.size_code, sz.sort_order, SUM(sk.qty) AS qty
         FROM trx_sales_order_line l
         JOIN trx_sales_order_sku sk ON sk.so_line_id = l.id
         JOIN mst_style_sku k ON k.id = sk.sku_id
         JOIN mst_size sz ON sz.id = k.size_id
         LEFT JOIN mst_style st ON st.id = l.style_id
         LEFT JOIN mst_color col ON col.id = COALESCE(l.color_id, k.color_id)
        WHERE l.so_id = ?
        GROUP BY l.style_id, st.style_code, st.style_name, col.id, col.color_name, sz.size_code, sz.sort_order
        ORDER BY st.style_code, col.color_name, sz.sort_order`, [soId]);
    const byKey = new Map<string, any>();
    for (const r of skus) {
      const key = `${r.style_id}|${r.color_id}`;
      const g = byKey.get(key) ?? { style_id: r.style_id, style_code: r.style_code, style_name: r.style_name, color_id: r.color_id, color_name: r.color_name, sizes: [] as { size_code: string; qty: number }[] };
      g.sizes.push({ size_code: r.size_code, qty: Number(r.qty) || 0 });
      byKey.set(key, g);
    }
    out.order_lines = [...byKey.values()];
  }
  const buyerQ = req.query.buyer_id ? Number(req.query.buyer_id) : null;
  const tplBuyer = out.buyer_id ?? buyerQ;
  if (tplBuyer) {
    const tpl = await buyerTemplate(cid, Number(tplBuyer));
    out.buyer_template = tpl;
    if (tpl) {
      // buyer default format / layout; the user may still pick another format
      out.pl_type = tpl.pl_type; out.ctn_numbering = tpl.ctn_numbering;
      if (tpl.notify_label) out.notify_label = tpl.notify_label;
      if (tpl.notify_details) out.notify_details = tpl.notify_details;
      if (tpl.other_references) out.other_references = tpl.other_references;
    }
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

async function buyerTemplate(cid: number, buyerId: number) {
  const t = await queryOne<any>(
    `SELECT t.*, b.party_name AS buyer_name, u.full_name AS updated_by_name FROM cfg_packing_list_buyer_template t
       JOIN mst_party b ON b.id = t.buyer_id LEFT JOIN mst_user u ON u.id = t.updated_by
      WHERE t.company_id = ? AND t.buyer_id = ?`, [cid, buyerId]);
  if (!t) return null;
  return { ...t, size_headers: asJson<string[] | null>(t.size_headers, null) };
}

/** GET /packing-lists/buyer-template?buyer_id= — buyer default format (Model 1 / 2 / 3) + layout defaults */
shipmentRouter.get('/packing-lists/buyer-template', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const buyerId = Number(req.query.buyer_id);
  if (!Number.isInteger(buyerId) || buyerId <= 0) throw BadRequest('buyer_id is required');
  res.json({ data: await buyerTemplate(req.user!.companyId, buyerId) });
}));

/** PUT /packing-lists/buyer-template — set the buyer's default packing list template */
shipmentRouter.put('/packing-lists/buyer-template', requirePermission('PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    buyer_id: z.coerce.number().int().positive(),
    pl_type: z.enum(PL_TYPES),
    ctn_numbering: z.enum(['SEQUENCE', 'CARTON_NO']).default('SEQUENCE'),
    size_headers: z.array(z.string().trim().min(1).max(20)).max(40).nullish(),
    notify_label: s.nullableStr(40),
    notify_details: s.nullableStr(2000),
    other_references: s.nullableStr(500),
  }).parse(req.body);
  const buyer = await queryOne<any>(`SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [b.buyer_id, cid]);
  if (!buyer) throw BadRequest('Buyer not found');
  const before = await buyerTemplate(cid, b.buyer_id);
  const sizes = b.size_headers?.length ? JSON.stringify(normaliseSizeHeaders(b.size_headers, 'Size headers')) : null;
  await transaction(async (tx) => {
    await txExecute(tx,
      `INSERT INTO cfg_packing_list_buyer_template (company_id, buyer_id, pl_type, ctn_numbering, size_headers, notify_label, notify_details, other_references, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE pl_type = VALUES(pl_type), ctn_numbering = VALUES(ctn_numbering), size_headers = VALUES(size_headers),
         notify_label = VALUES(notify_label), notify_details = VALUES(notify_details), other_references = VALUES(other_references), updated_by = VALUES(updated_by)`,
      [cid, b.buyer_id, b.pl_type, b.ctn_numbering, sizes, b.notify_label ?? null, b.notify_details ?? null, b.other_references ?? null, req.user!.id]);
  });
  const after = await buyerTemplate(cid, b.buyer_id);
  await audit(req, 'cfg_packing_list_buyer_template', after.id, before ? 'UPDATE' : 'INSERT', before ?? undefined, after);
  res.json({ data: after });
}));

/** GET /packing-lists/pack-summary?so_id=&io_no=&pl_id= — Order | Packed | On this list | Balance + packaging stock */
shipmentRouter.get('/packing-lists/pack-summary', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = req.query.so_id ? Number(req.query.so_id) : null;
  const ioNo = req.query.io_no ? String(req.query.io_no).slice(0, 40) : null;
  const plIdQ = req.query.pl_id ? Number(req.query.pl_id) : null;
  if (plIdQ && !(await queryOne(`SELECT id FROM trx_packing_list WHERE id = ? AND company_id = ?`, [plIdQ, cid]))) throw NotFound('Packing list not found');
  res.json({ data: await packSummary(cid, soId && soId > 0 ? soId : null, ioNo, plIdQ && plIdQ > 0 ? plIdQ : null) });
}));

/** "60x40x30" / "60 X 40 X 30 CM" in the carton type's specification → dims (fallback when the carton has none). */
const dimsFromSpec = (spec: unknown) => {
  const m = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(String(spec ?? ''));
  return m ? { length_cm: Number(m[1]), width_cm: Number(m[2]), height_cm: Number(m[3]) } : null;
};

/**
 * GET /packing-lists/build-rows?packing_id= | so_id= | io_no= [&format=ASSORTED|SOLID|MIXED]
 *     [&numbering=SEQUENCE|CARTON_NO][&start=1][&pl_id=]
 * AUTO-FILL: carton rows built from the READY cartons (posted, verified / sealed) of a
 * packing order, sales order or job that are not on another packing list nor on an
 * active shipment, grouped per the format's rule (packingListCalc.buildFormatBlocks):
 *   Model 1 ASSORTED  identical consecutive cartons → one range row, block per style
 *   Model 2 SOLID     carton-wise rows, block (= sub-total) per style / colour
 *   Model 3 MIXED     PCS/PACK × PACK/CTN from the packing-rule snapshot, block per style set
 * Carton numbers run 1..N on the list (SEQUENCE, as on the buyer sheet) or keep the
 * physical carton numbers (CARTON_NO). format=AUTO → inferred from the contents (blocks kept);
 * no format at all (older callers) → inferred, everything in one block.
 * Preview only; the user saves the list afterwards.
 */
shipmentRouter.get('/packing-lists/build-rows', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const packingId = req.query.packing_id ? Number(req.query.packing_id) : null;
  const soId = req.query.so_id ? Number(req.query.so_id) : null;
  const ioNo = req.query.io_no ? String(req.query.io_no).trim().slice(0, 40) : null;
  const ownPl = req.query.pl_id ? Number(req.query.pl_id) : 0;
  const fmtQ = req.query.format ? String(req.query.format).toUpperCase() : '';
  if (fmtQ && fmtQ !== 'AUTO' && !(PL_TYPES as readonly string[]).includes(fmtQ)) throw BadRequest('format must be ASSORTED, SOLID, MIXED or AUTO');
  const numQ = String(req.query.numbering ?? 'SEQUENCE').toUpperCase();
  if (!['SEQUENCE', 'CARTON_NO'].includes(numQ)) throw BadRequest('numbering must be SEQUENCE or CARTON_NO');
  const startQ = req.query.start ? Number(req.query.start) : 1;
  if (!Number.isInteger(startQ) || startQ < 1 || startQ > 1_000_000) throw BadRequest('start must be a carton number from 1');
  if (!packingId && !soId && !ioNo) throw BadRequest('Pick a packing, sales order or job to build rows from');
  if (packingId != null && (!Number.isInteger(packingId) || packingId <= 0)) throw BadRequest('Invalid packing_id');
  let orderNo: string | null = null, orderSoId: number | null = soId;
  if (packingId) {
    const packing = await queryOne<any>(
      `SELECT p.id, p.so_id, so.buyer_po_no, so.so_no FROM trx_packing p LEFT JOIN trx_sales_order so ON so.id = p.so_id
        WHERE p.id = ? AND p.company_id = ?`, [packingId, cid]);
    if (!packing) throw NotFound('Packing record not found');
    orderNo = packing.buyer_po_no ?? packing.so_no ?? null; orderSoId = packing.so_id ?? null;
  } else if (soId) {
    const so = await queryOne<any>(`SELECT id, buyer_po_no, so_no FROM trx_sales_order WHERE id = ? AND company_id = ?`, [soId, cid]);
    if (!so) throw NotFound('Sales order not found');
    orderNo = so.buyer_po_no ?? so.so_no ?? null;
  }
  const where = packingId ? 'c.packing_id = ?' : soId ? 'p.so_id = ?' : 'p.io_no = ?';
  const all = await query<any>(
    `SELECT c.id, c.packing_id, c.carton_no, c.carton_seq, c.carton_status, c.is_posted, c.net_weight_kg, c.gross_weight_kg,
            c.length_cm, c.width_cm, c.height_cm, c.polybag_qty, ct.specification AS carton_spec,
            p.so_id, p.rule_snapshot, so.buyer_po_no, so.so_no,
            (SELECT pl.pl_no FROM trx_packing_list_carton plc JOIN trx_packing_list pl ON pl.id = plc.packing_list_id
              WHERE plc.carton_id = c.id AND plc.packing_list_id <> ? LIMIT 1) AS other_pl,
            (SELECT sh.shipment_no FROM trx_shipment_package sp JOIN trx_shipment sh ON sh.id = sp.shipment_id
              WHERE sp.carton_id = c.id AND sp.status <> 'CANCELLED' LIMIT 1) AS shipment_no
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
       LEFT JOIN trx_sales_order so ON so.id = p.so_id
       LEFT JOIN mst_trim ct ON ct.id = c.carton_trim_id
      WHERE ${where}`, [ownPl, cid, packingId ?? soId ?? ioNo]);
  if (!all.length) throw BadRequest('No cartons are packed for this yet');
  const isReady = (c: any) => Number(c.is_posted) === 1 && ['VERIFIED', 'SEALED'].includes(c.carton_status);
  const cartons = all.filter((c: any) => isReady(c) && !c.other_pl && !c.shipment_no);
  const skipped = {
    not_ready: all.filter((c: any) => !isReady(c) && c.carton_status !== 'DISPATCHED' && c.carton_status !== 'VOID').length,
    on_other_list: all.filter((c: any) => isReady(c) && c.other_pl).length,
    shipped: all.filter((c: any) => c.carton_status === 'DISPATCHED' || (isReady(c) && !c.other_pl && c.shipment_no)).length,
  };
  if (!cartons.length) throw BadRequest(`No ready cartons to list: ${skipped.not_ready} not yet posted / verified, ${skipped.on_other_list} already on another packing list, ${skipped.shipped} shipped`);
  if (!orderNo) { const f = cartons[0]; orderNo = f.buyer_po_no ?? f.so_no ?? null; orderSoId = orderSoId ?? f.so_id ?? null; }
  const ids = cartons.map((c: any) => c.id);
  const contents = await query<any>(
    `SELECT cc.carton_id, st.id AS style_id, st.style_code, st.style_name, col.id AS color_id, col.color_name,
            sz.size_code, sz.sort_order, SUM(cc.qty) AS qty
       FROM trx_carton_content cc
       LEFT JOIN mst_style_sku k ON k.id = cc.sku_id
       JOIN mst_style st ON st.id = COALESCE(cc.style_id, k.style_id)
       JOIN mst_color col ON col.id = COALESCE(cc.color_id, k.color_id)
       JOIN mst_size sz ON sz.id = COALESCE(cc.size_id, k.size_id)
      WHERE cc.carton_id IN (?)
      GROUP BY cc.carton_id, st.id, st.style_code, st.style_name, col.id, col.color_name, sz.size_code, sz.sort_order
      ORDER BY sz.sort_order`, [ids]);
  const byCarton = new Map<number, any[]>();
  for (const x of contents) {
    const a = byCarton.get(x.carton_id) ?? [];
    a.push({ ...x, style_id: Number(x.style_id), color_id: Number(x.color_id), qty: Number(x.qty), size_rank: Number(x.sort_order ?? 9999) });
    byCarton.set(x.carton_id, a);
  }
  let dimsFromType = 0;
  const forBuild = cartons.map((c: any) => {
    const rule = asJson<any>(c.rule_snapshot, null);
    let dims = { length_cm: c.length_cm, width_cm: c.width_cm, height_cm: c.height_cm };
    if (dims.length_cm == null || dims.width_cm == null || dims.height_cm == null) {
      const d = dimsFromSpec(c.carton_spec);
      if (d) { dims = d; dimsFromType++; }
    }
    return {
      id: Number(c.id), packing_id: Number(c.packing_id), carton_no: String(c.carton_no), carton_seq: c.carton_seq == null ? null : Number(c.carton_seq),
      net_weight_kg: c.net_weight_kg, gross_weight_kg: c.gross_weight_kg, ...dims,
      polybag_qty: Number(c.polybag_qty || 0),
      pieces_per_polybag: rule?.pieces_per_polybag != null ? Number(rule.pieces_per_polybag) : null,
      rule_code: rule?.rule_code ?? null,
      contents: byCarton.get(c.id) ?? [],
    };
  }).filter((c: any) => c.contents.length);
  const empty = cartons.length - forBuild.length;
  if (!forBuild.length) throw BadRequest('The ready cartons hold no pieces');
  const built = buildFormatBlocks(forBuild, {
    format: (fmtQ && fmtQ !== 'AUTO' ? fmtQ : null) as PlType | null, numbering: numQ as any, start: startQ, orderNo, soId: orderSoId,
  });
  if (built.problems.length) throw BadRequest(built.problems.join('; '));
  // no format asked (older callers): one block, type inferred from the contents
  if (!fmtQ) built.blocks = [{ label: null, size_headers: null, rows: built.blocks.flatMap((b) => b.rows).sort((a, b) => a.ctn_from - b.ctn_from) }];
  const rowCount = built.blocks.reduce((a, b) => a + b.rows.length, 0);
  res.json({ data: {
    size_headers: built.size_headers, pl_type: built.pl_type, blocks: built.blocks, empty_cartons: empty,
    has_gaps: built.has_gaps, numbering: built.numbering, skipped, carton_info: await cartonInfo(cid, ids),
    row_count: rowCount, carton_count: forBuild.length, dims_from_carton_type: dimsFromType,
    missing_weight: forBuild.filter((c: any) => c.gross_weight_kg == null).length,
  } });
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
    const taken = (no: string) => txQueryOne(tx, `SELECT id FROM trx_packing_list WHERE company_id = ? AND pl_no = ?`, [cid, no]);
    let plNo = body.pl_no || await nextDocNumber(tx, cid, 'PACKING_LIST');
    if (body.pl_no) {
      if (await taken(plNo)) throw BadRequest(`Packing list number "${plNo}" already exists`);
    } else {
      // the series can lag behind numbers typed by hand (PL-00001 exists, series at 1) — move past them
      for (let i = 0; i < 200 && await taken(plNo); i++) plNo = await nextDocNumber(tx, cid, 'PACKING_LIST');
      if (await taken(plNo)) throw BadRequest(`Packing list number "${plNo}" already exists`);
    }
    const t = await headerTotals(tx, body, computed);
    const r = await txExecute(tx,
      `INSERT INTO trx_packing_list
         (company_id, pl_no, ${HEADER_COLS.join(', ')}, size_headers, status,
          total_cartons, total_qty, net_weight_kg, gross_weight_kg, total_cbm, style_summary, created_by)
       VALUES (?,?,${HEADER_COLS.map(() => '?').join(',')},?,'DRAFT',?,?,?,?,?,?,?)`,
      [cid, plNo, ...headerValues(body), headers ? JSON.stringify(headers) : null,
       t.total_cartons, t.total_qty, t.net_weight_kg, t.gross_weight_kg, t.total_cbm, t.style_summary, req.user!.id]);
    if (computed) await writeStructure(tx, cid, r.insertId, computed);
    await syncCartonLinks(tx, cid, r.insertId, computed);
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
    await syncCartonLinks(tx, cid, id, computed);
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
  const { over_ship_reason } = z.object({ over_ship_reason: s.nullableStr(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pl) throw NotFound('Packing list not found');
    if (pl.status !== 'DRAFT') throw BadRequest(`Packing list is already ${pl.status}`);
    const st = await loadStructure(id, asJson(pl.size_headers, null), { tx });
    const rows = st.blocks.flatMap((b) => b.rows);
    if (!rows.length && !pl.packing_id) throw BadRequest('Add carton rows (or link a packing) before confirming');
    const noWeight = rows.filter((r) => !r.gross_wt_per_ctn);
    if (noWeight.length) throw BadRequest(`Gross weight per carton is missing on cartons ${noWeight.map((r) => `${r.ctn_from}-${r.ctn_to}`).join(', ')}`);
    // rows built from posted cartons: list totals must equal the cartons' totals (developer doc §17 / §20)
    const srcIds = [...new Set(rows.flatMap((r) => r.source_carton_ids ?? []))];
    if (srcIds.length) {
      const cs = await txQuery<any>(tx,
        `SELECT c.id, c.carton_no, c.is_posted, c.carton_status, plc.packing_list_id AS pl_link
           FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
           LEFT JOIN trx_packing_list_carton plc ON plc.carton_id = c.id
          WHERE c.id IN (?) FOR UPDATE`, [cid, srcIds]);
      if (cs.length !== srcIds.length)
        throw BadRequest(`${srcIds.length - cs.length} carton(s) these rows were built from no longer exist; rebuild the rows from the packed cartons before confirming`);
      const notReady = cs.filter((c: any) => !(Number(c.is_posted) === 1 && ['VERIFIED', 'SEALED'].includes(c.carton_status)));
      if (notReady.length) throw BadRequest(`Carton(s) ${notReady.map((c: any) => `${c.carton_no} (${c.carton_status})`).join(', ')} are no longer posted / sealed; rebuild the rows before confirming`);
      const elsewhere = cs.filter((c: any) => Number(c.pl_link) !== id);
      if (elsewhere.length) throw BadRequest(`Carton(s) ${elsewhere.map((c: any) => c.carton_no).join(', ')} are not linked to this packing list; save the list again`);
      const qty = await cartonQtyMap({ tx }, srcIds);
      const bad: string[] = [];
      let listQty = 0, cartonQty = 0, listCtns = 0;
      for (const r of rows) {
        const ids = r.source_carton_ids ?? [];
        if (!ids.length) continue;
        const q = ids.reduce((a, c) => a + (qty.get(c) ?? 0), 0);
        listQty += r.total_qty; cartonQty += q; listCtns += r.no_of_ctns;
        if (ids.length !== r.no_of_ctns) bad.push(`cartons ${r.ctn_from}-${r.ctn_to}: ${r.no_of_ctns} carton(s) on the list, ${ids.length} packed`);
        else if (q !== r.total_qty) bad.push(`cartons ${r.ctn_from}-${r.ctn_to}: ${r.total_qty} pcs on the list, ${q} pcs in the packed cartons`);
      }
      if (bad.length || listQty !== cartonQty || listCtns !== srcIds.length)
        throw BadRequest(`Packing list totals do not match the posted cartons (list ${listCtns} ctns / ${listQty} pcs, cartons ${srcIds.length} / ${cartonQty} pcs)${bad.length ? `: ${bad.slice(0, 5).join('; ')}` : ''}. Rebuild the rows from the packed cartons`);
    }
    // over-shipment (shipped > order qty, spec §10): shown separately and confirmed only with an approval reason
    const over = overShipment(await buildSummary(cid, id, pl.so_id ? Number(pl.so_id) : null, st));
    let overNote: string | null = null;
    if (over.qty > 0) {
      const detail = over.lines.slice(0, 4).map((l) => `${l.style ?? ''} ${l.colour ?? ''}: ${Object.entries(l.excess).map(([k, v]) => `${k} +${v}`).join(' ')}`.trim()).join('; ');
      if (!over_ship_reason) throw BadRequest(`Over-shipment: ${over.qty} pcs more than the order qty (${detail}). Give an approval reason to confirm`);
      if (!req.user!.permissions.has('PACKING.APPROVE')) throw BadRequest('Confirming an over-shipment needs the Approve Packing right (PACKING.APPROVE)');
      overNote = `${over.qty} pcs over order — ${over_ship_reason}`.slice(0, 255);
    }
    await txExecute(tx, `UPDATE trx_packing_list SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW(), over_ship_note = ? WHERE id = ?`, [req.user!.id, overNote, id]);
    await audit(req, 'trx_packing_list', id, 'UPDATE', { status: pl.status }, { status: 'CONFIRMED', totals: st.totals, revision_no: pl.revision_no, over_shipment: over.qty ? over : undefined, over_ship_note: overNote }, tx);
  });
  res.json({ data: await loadPackingList(cid, id) });
}));

/**
 * POST /packing-lists/:id/revise (alias /reopen) — controlled revision of a CONFIRMED list
 * (spec §8 / §13: a confirmed list is immutable; changes need a revision). The confirmed
 * version is frozen in trx_packing_list_revision (header, rows, totals, order summary and
 * the printed layout), revision_no goes up by one and the list returns to DRAFT for the
 * correction. Needs PACKING.DELETE (the strongest packing right) and a reason; refused once
 * a live shipment references the list.
 */
const reviseHandler = ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = plId(req.params.id);
  const { reason } = z.object({ reason: s.strReq(255) }).parse(req.body);
  const frozen = await loadPackingList(cid, id);
  await transaction(async (tx) => {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pl) throw NotFound('Packing list not found');
    if (pl.status !== 'CONFIRMED') throw BadRequest(`Only a CONFIRMED packing list can be revised (this one is ${pl.status})`);
    const ship = await txQueryOne<any>(tx,
      `SELECT shipment_no FROM trx_shipment WHERE packing_list_id = ? AND company_id = ?
          AND COALESCE(remarks,'') NOT LIKE '%[CANCELLED]%' LIMIT 1`, [id, cid]);
    if (ship) throw BadRequest(`Packing list is used by shipment ${ship.shipment_no}; cancel the shipment first`);
    const rev = Number(pl.revision_no || 0);
    const { cartons: _c, summary: _s, pack_summary: _p, carton_info: _i, revisions: _r, ...snap } = frozen as any;
    await txExecute(tx,
      `INSERT INTO trx_packing_list_revision (company_id, packing_list_id, revision_no, pl_type, total_cartons, total_qty, net_weight_kg, gross_weight_kg,
         total_cbm, confirmed_by, confirmed_at, reason, snapshot, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, id, rev, pl.pl_type, pl.total_cartons, pl.total_qty, pl.net_weight_kg, pl.gross_weight_kg, pl.total_cbm,
       pl.confirmed_by, pl.confirmed_at, reason, JSON.stringify(snap), req.user!.id]);
    await txExecute(tx, `UPDATE trx_packing_list SET status = 'DRAFT', revision_no = ?, reopen_reason = ?, confirmed_by = NULL, confirmed_at = NULL,
                            over_ship_note = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`, [rev + 1, reason, req.user!.id, id]);
    await audit(req, 'trx_packing_list', id, 'UPDATE', { status: 'CONFIRMED', revision_no: rev, totals: frozen.totals },
      { status: 'DRAFT', revision_no: rev + 1, reopen_reason: reason }, tx);
  });
  res.json({ data: await loadPackingList(cid, id) });
});
shipmentRouter.post('/packing-lists/:id/revise', requirePermission('PACKING.DELETE'), reviseHandler);
shipmentRouter.post('/packing-lists/:id/reopen', requirePermission('PACKING.DELETE'), reviseHandler);

/** GET /packing-lists/:id/revisions/:rev — a frozen (earlier confirmed) version, with its printed layout */
shipmentRouter.get('/packing-lists/:id/revisions/:rev', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const r = await queryOne<any>(
    `SELECT r.*, u.full_name AS created_by_name FROM trx_packing_list_revision r LEFT JOIN mst_user u ON u.id = r.created_by
      WHERE r.packing_list_id = ? AND r.company_id = ? AND r.revision_no = ?`, [plId(req.params.id), cid, Number(req.params.rev)]);
  if (!r) throw NotFound('Revision not found');
  res.json({ data: { ...r, snapshot: asJson(r.snapshot, null) } });
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
  incoterm: z.preprocess((v) => (v === '' ? null : v), z.enum(INCOTERMS).nullish()),   // the form's blank option sends ''
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

/** Next SHIPMENT number, moving past numbers already used (the series can lag hand-typed / seeded numbers). */
async function nextShipmentNo(tx: any, cid: number) {
  let no = await nextDocNumber(tx, cid, 'SHIPMENT');
  for (let i = 0; i < 200 && await txQueryOne(tx, `SELECT id FROM trx_shipment WHERE company_id = ? AND shipment_no = ?`, [cid, no]); i++)
    no = await nextDocNumber(tx, cid, 'SHIPMENT');
  return no;
}

type ShipCarton = { id: number; packing_id: number; carton_no: string; qty: number; net: number; gross: number; cbm: number };

/** A carton that can go on a shipment: same company, READY, not on another active shipment. Locks the row. */
async function lockShippableCarton(tx: any, cid: number, cartonId: number, exceptShipmentId = 0): Promise<ShipCarton> {
  const c = await txQueryOne<any>(tx,
    `SELECT c.id, c.packing_id, c.carton_no, c.is_posted, c.carton_status, c.net_weight_kg, c.gross_weight_kg, c.cbm
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
      WHERE c.id = ? FOR UPDATE`, [cid, cartonId]);
  if (!c) throw BadRequest(`Carton #${cartonId} not found`);
  if (!(Number(c.is_posted) === 1 && ['VERIFIED', 'SEALED'].includes(c.carton_status)))
    throw BadRequest(`Carton ${c.carton_no} is ${c.carton_status}${Number(c.is_posted) ? '' : ' (not posted)'} — only posted, verified / sealed cartons can be shipped`);
  const other = await txQueryOne<any>(tx,
    `SELECT sh.shipment_no FROM trx_shipment_package sp JOIN trx_shipment sh ON sh.id = sp.shipment_id
      WHERE sp.carton_id = ? AND sp.status <> 'CANCELLED' AND sp.shipment_id <> ? LIMIT 1`, [cartonId, exceptShipmentId]);
  if (other) throw BadRequest(`Carton ${c.carton_no} is already on shipment ${other.shipment_no}`);
  const q = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(qty),0) AS q FROM trx_carton_content WHERE carton_id = ?`, [cartonId]);
  return { id: c.id, packing_id: c.packing_id, carton_no: c.carton_no, qty: Number(q?.q || 0),
           net: Number(c.net_weight_kg || 0), gross: Number(c.gross_weight_kg || 0), cbm: Number(c.cbm || 0) };
}

/**
 * What a shipment / plan carries:
 *  - from a CONFIRMED packing list built from cartons → its READY cartons (packages, qty, weights, CBM);
 *  - from a hand-made CONFIRMED list (no cartons) → the list's row totals, basis PACKING_LIST;
 *  - without a list → the picked cartons (each READY and not on another active shipment).
 */
async function resolveShipmentSource(tx: any, cid: number, plId: number | null | undefined, packageIds: number[], opts: { forPlan?: boolean } = {}) {
  let pl: any = null;
  let ids = [...new Set(packageIds)];
  if (plId) {
    pl = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [plId, cid]);
    if (!pl) throw BadRequest(`Packing list #${plId} not found`);
    if (pl.status !== 'CONFIRMED') throw BadRequest(`Packing list ${pl.pl_no} is ${pl.status} — confirm it before creating a shipment from it`);
    const ship = await txQueryOne<any>(tx,
      `SELECT sh.shipment_no FROM trx_shipment sh WHERE sh.packing_list_id = ? AND sh.company_id = ? AND ${ACTIVE_SHIP_SQL} LIMIT 1`, [plId, cid]);
    if (ship) throw BadRequest(`Packing list ${pl.pl_no} is already on shipment ${ship.shipment_no}`);
    if (opts.forPlan) {
      const plan = await txQueryOne<any>(tx,
        `SELECT plan_no FROM trx_shipment_plan WHERE packing_list_id = ? AND company_id = ? AND status IN ('DRAFT','CONFIRMED') LIMIT 1`, [plId, cid]);
      if (plan) throw BadRequest(`Packing list ${pl.pl_no} is already planned on ${plan.plan_no}`);
    }
    const linked = (await txQuery<any>(tx, `SELECT carton_id FROM trx_packing_list_carton WHERE packing_list_id = ?`, [plId]))
      .map((r: any) => Number(r.carton_id));
    if (linked.length) {
      const set = new Set(linked);
      const stray = ids.filter((i) => !set.has(i));
      if (stray.length) throw BadRequest(`${stray.length} picked carton(s) are not on packing list ${pl.pl_no}`);
      if (!ids.length) ids = linked;
    } else if (ids.length) {
      throw BadRequest(`Packing list ${pl.pl_no} is not built from packed cartons — ship it as a list (no cartons picked)`);
    }
  }
  if (pl && !ids.length) {
    const t = { packages: Number(pl.total_cartons || 0), qty: Number(pl.total_qty || 0), net: Number(pl.net_weight_kg || 0),
                gross: Number(pl.gross_weight_kg || 0), cbm: Number(pl.total_cbm || 0) };
    if (!t.packages || !t.qty) throw BadRequest(`Packing list ${pl.pl_no} has no cartons / quantity to ship`);
    return { pl, basis: 'PACKING_LIST' as const, cartons: [] as ShipCarton[], totals: t };
  }
  // From a confirmed list, each carton ships with the weights / CBM of its list row (the confirmed document;
  // engine cartons can be posted without weights, which are then typed on the list); else the carton's own.
  const rowOf = new Map<number, { net: number | null; gross: number | null; cbm: number | null }>();
  if (pl) {
    const plRows = await txQuery<any>(tx,
      `SELECT source_carton_ids, net_wt_per_ctn, gross_wt_per_ctn, cbm_per_ctn FROM trx_packing_list_row WHERE packing_list_id = ?`, [pl.id]);
    for (const r of plRows) {
      const src = typeof r.source_carton_ids === 'string' ? JSON.parse(r.source_carton_ids) : r.source_carton_ids;
      for (const c of (Array.isArray(src) ? src : [])) rowOf.set(Number(c), {
        net: r.net_wt_per_ctn == null ? null : Number(r.net_wt_per_ctn), gross: r.gross_wt_per_ctn == null ? null : Number(r.gross_wt_per_ctn),
        cbm: r.cbm_per_ctn == null ? null : Number(r.cbm_per_ctn) });
    }
  }
  const cartons: ShipCarton[] = [];
  for (const id of ids) {
    const c = await lockShippableCarton(tx, cid, id);
    const w = rowOf.get(id);
    if (w) { c.net = w.net ?? c.net; c.gross = w.gross ?? c.gross; c.cbm = w.cbm ?? c.cbm; }
    cartons.push(c);
  }
  const totals = {
    packages: cartons.length, qty: cartons.reduce((a, c) => a + c.qty, 0), net: r3(cartons.reduce((a, c) => a + c.net, 0)),
    gross: r3(cartons.reduce((a, c) => a + c.gross, 0)), cbm: r5(cartons.reduce((a, c) => a + c.cbm, 0)),
  };
  return { pl, basis: 'CARTONS' as const, cartons, totals };
}

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
            pl.pl_no AS packing_list_no, pl.status AS packing_list_status,
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
            c.cbm AS carton_cbm, c.carton_status, p.pack_no
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
    const src = await resolveShipmentSource(tx, cid, body.packing_list_id, body.package_ids);
    const pl = src.pl;
    // a shipment from a packing list carries its order / job / parties unless typed
    const pick = <T,>(v: T | null | undefined, fromPl: any) => (v != null && v !== '' ? v : (fromPl ?? null));
    const shipNo = body.shipment_no || await nextShipmentNo(tx, cid);
    const r = await txExecute(tx,
      `INSERT INTO trx_shipment
        (company_id, shipment_no, io_no, so_id, packing_list_id, buyer_id, consignee_id,
         notify_party_id, shipment_type, mode, incoterm, destination, country_id, freight_terms,
         invoice_id, dispatch_id, shipping_bill_id, forwarder_id, shipping_line, vessel_name,
         voyage_no, bl_no, bl_date, etd, eta, pol, pod, remarks, created_by, package_basis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, shipNo, pick(body.io_no, pl?.io_no), pick(body.so_id, pl?.so_id), body.packing_list_id ?? null,
       pick(body.buyer_id, pl?.buyer_id), pick(body.consignee_id, pl?.consignee_id), body.notify_party_id ?? null,
       pl && !req.body?.shipment_type ? (pl.shipment_type ?? body.shipment_type) : body.shipment_type,
       body.mode, body.incoterm ?? null, pick(body.destination, pl?.destination ?? pl?.final_destination),
       body.country_id ?? null, body.freight_terms ?? null,
       pick(body.invoice_id, pl?.invoice_id), body.dispatch_id ?? null, body.shipping_bill_id ?? null,
       body.forwarder_id ?? null, body.shipping_line ?? null, body.vessel_name ?? null,
       body.voyage_no ?? null, body.bl_no ?? null, body.bl_date ?? null,
       body.etd ?? null, body.eta ?? null, pick(body.pol, pl?.port_of_loading), pick(body.pod, pl?.port_of_discharge),
       body.remarks ?? null, req.user!.id, src.basis]);
    const shipmentId = r.insertId;

    for (const c of src.cartons) {
      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`, [shipmentId, c.id, c.packing_id, c.carton_no, c.qty, c.gross, c.cbm]);
    }
    const t = src.totals;
    await txExecute(tx,
      `UPDATE trx_shipment SET total_packages = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?, total_cbm = ? WHERE id = ?`,
      [t.packages, t.qty, t.net, t.gross, t.cbm, shipmentId]);

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
  if (String(shipment.remarks || '').includes('[CANCELLED]')) throw BadRequest(`Shipment ${shipment.shipment_no} is cancelled`);
  if (shipment.package_basis === 'PACKING_LIST') throw BadRequest(`Shipment ${shipment.shipment_no} ships packing list totals (no physical cartons); cartons cannot be added`);

  let allocated = 0;
  await transaction(async (tx) => {
    for (const cartonId of [...new Set(package_ids)]) {
      const mine = await txQueryOne<any>(tx,
        `SELECT id FROM trx_shipment_package WHERE carton_id = ? AND shipment_id = ? AND status != 'CANCELLED'`, [cartonId, shipmentId]);
      if (mine) continue;                                   // already on this shipment
      const c = await lockShippableCarton(tx, cid, cartonId);
      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`, [shipmentId, c.id, c.packing_id, c.carton_no, c.qty, c.gross, c.cbm]);
      allocated++;
    }

    // Recalculate shipment totals
    const agg = await txQueryOne<any>(tx,
      `SELECT COUNT(*) AS pkgs, COALESCE(SUM(sp.allocated_qty),0) AS qty, COALESCE(SUM(c.net_weight_kg),0) AS net,
              COALESCE(SUM(sp.gross_weight_kg),0) AS gross, COALESCE(SUM(sp.cbm),0) AS cbm
         FROM trx_shipment_package sp JOIN trx_carton c ON c.id = sp.carton_id
        WHERE sp.shipment_id = ? AND sp.status != 'CANCELLED'`, [shipmentId]);
    await txExecute(tx,
      `UPDATE trx_shipment SET total_packages = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?, total_cbm = ? WHERE id = ?`,
      [agg?.pkgs || 0, agg?.qty || 0, agg?.net || 0, agg?.gross || 0, agg?.cbm || 0, shipmentId]);
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
    if (body.shipment_id) {
      const sh = await txQueryOne<any>(tx, `SELECT id, shipment_no, remarks FROM trx_shipment WHERE id = ? AND company_id = ? FOR UPDATE`, [body.shipment_id, cid]);
      if (!sh) throw BadRequest('Shipment not found');
      if (String(sh.remarks || '').includes('[CANCELLED]')) throw BadRequest(`Shipment ${sh.shipment_no} is cancelled`);
    }
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

    // Shipment packages → DISPATCHED, and their physical cartons too (packing contract, db/118)
    if (body.shipment_id) {
      await txExecute(tx,
        `UPDATE trx_shipment_package SET status = 'DISPATCHED' WHERE shipment_id = ? AND status = 'ALLOCATED'`, [body.shipment_id]);
      // cartons packed from the FG store leave the store now (FINISHED out of the stock ledger, client call 16-Oct-2026)
      const leaving = await txQuery<any>(tx,
        `SELECT c.id, c.carton_no, p.io_no, p.style_id, p.so_id, u.color_id, u.size_id, u.qty
           FROM trx_carton c JOIN trx_shipment_package sp ON sp.carton_id = c.id JOIN trx_packing p ON p.id = c.packing_id
           JOIN trx_carton_fg_use u ON u.carton_id = c.id  -- what the carton took from the FG store (a set: TOP + BOTTOM)
          WHERE sp.shipment_id = ? AND sp.status = 'DISPATCHED' AND c.carton_status <> 'DISPATCHED' AND c.from_fg = 1 AND c.is_posted = 1`, [body.shipment_id]);
      await txExecute(tx,
        `UPDATE trx_carton c JOIN trx_shipment_package sp ON sp.carton_id = c.id
            SET c.carton_status = 'DISPATCHED'
          WHERE sp.shipment_id = ? AND sp.status = 'DISPATCHED' AND c.carton_status <> 'DISPATCHED'`, [body.shipment_id]);
      for (const x of leaving) {
        // the store and value the job's FG receipts used (latest), so the FG stock of that store goes down
        const src = await txQueryOne<any>(tx,
          `SELECT sl.warehouse_id, sl.rate, sl.uom_id, sl.sku_id FROM trx_stock_ledger sl JOIN trx_fg_receipt r ON r.id = sl.ref_id AND sl.ref_type = 'FG_RECEIPT'
            WHERE r.company_id = ? AND r.io_no = ? AND r.style_id = ? AND sl.color_id = ? AND r.status <> 'CANCELLED'
              AND sl.sku_id = (SELECT k.id FROM mst_style_sku k WHERE k.style_id = ? AND k.color_id = ? AND k.size_id = ? LIMIT 1)
            ORDER BY sl.id DESC LIMIT 1`, [cid, x.io_no, x.style_id, x.color_id, x.style_id, x.color_id, x.size_id]);
        if (!src) continue; // carton posted before FG receipts existed for this colour / size
        await txExecute(tx,
          `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, sku_id, color_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate, so_id, created_by)
           VALUES (?,?,'FINISHED',?,?,'DISPATCH','DISPATCH',?,0,?,?,?,?,?)`,
          [cid, src.warehouse_id, src.sku_id, x.color_id, r.insertId, x.qty, src.uom_id, src.rate, x.so_id ?? null, req.user!.id]);
      }
      await txExecute(tx, `UPDATE trx_shipment SET tracking_status = 'GATED_IN' WHERE id = ?`, [body.shipment_id]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_dispatch WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_dispatch', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));


// ============================================================
// AVAILABLE PACKAGES FOR SHIPMENT
// ============================================================

/**
 * GET /available-packages?packing_id=&packing_list_id= — READY cartons (posted, verified / sealed)
 * not on any active shipment; with packing_list_id only that list's cartons.
 */
shipmentRouter.get('/available-packages', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const packingId = req.query.packing_id ? Number(req.query.packing_id) : null;
  const plIdQ = req.query.packing_list_id ? Number(req.query.packing_list_id) : null;

  let sql = `SELECT c.*, p.pack_no, p.so_id, p.io_no, pl.pl_no,
                    COALESCE(SUM(cc.qty), 0) AS content_qty,
                    GROUP_CONCAT(DISTINCT CONCAT(col.color_name, ' ', sz.size_code) SEPARATOR ', ') AS sku_summary
               FROM trx_carton c
               JOIN trx_packing p ON p.id = c.packing_id
               LEFT JOIN trx_packing_list_carton plc ON plc.carton_id = c.id
               LEFT JOIN trx_packing_list pl ON pl.id = plc.packing_list_id
               LEFT JOIN trx_carton_content cc ON cc.carton_id = c.id
               LEFT JOIN mst_style_sku k ON k.id = cc.sku_id
               LEFT JOIN mst_color col ON col.id = COALESCE(cc.color_id, k.color_id)
               LEFT JOIN mst_size sz ON sz.id = COALESCE(cc.size_id, k.size_id)
              WHERE p.company_id = ? AND ${READY_SQL}
                AND c.id NOT IN (
                  SELECT sp.carton_id FROM trx_shipment_package sp WHERE sp.status != 'CANCELLED'
                )`;
  const params: any[] = [cid];

  if (packingId) {
    sql += ` AND c.packing_id = ?`;
    params.push(packingId);
  }
  if (plIdQ) {
    sql += ` AND plc.packing_list_id = ?`;
    params.push(plIdQ);
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
    `SELECT sp.*, b.party_name AS buyer_name, pl.pl_no AS packing_list_no
       FROM trx_shipment_plan sp
       LEFT JOIN mst_party b ON b.id = sp.buyer_id
       LEFT JOIN trx_packing_list pl ON pl.id = sp.packing_list_id
      WHERE sp.company_id = ?
      ORDER BY sp.planned_date DESC, sp.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /shipment-plans/:id */
shipmentRouter.get('/shipment-plans/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT sp.*, b.party_name AS buyer_name, pl.pl_no AS packing_list_no
       FROM trx_shipment_plan sp
       LEFT JOIN mst_party b ON b.id = sp.buyer_id
       LEFT JOIN trx_packing_list pl ON pl.id = sp.packing_list_id
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

/** POST /shipment-plans — from picked READY cartons, or from a CONFIRMED packing list */
shipmentRouter.post('/shipment-plans', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    plan_no: s.nullableStr(40),
    planned_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    buyer_id: s.id(),
    packing_list_id: s.id(),
    shipment_type: z.enum(['DOMESTIC','EXPORT']).default('DOMESTIC'),
    mode: z.enum(MODES).default('ROAD'),
    destination: s.nullableStr(120),
    package_ids: z.array(z.coerce.number().int().positive()).default([]),
    remarks: s.text(),
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    const src = await resolveShipmentSource(tx, cid, body.packing_list_id, body.package_ids, { forPlan: true });
    const pl = src.pl;
    const planNo = body.plan_no || await nextDocNumber(tx, cid, 'SHIP_PLAN');
    const t = src.totals;
    const r = await txExecute(tx,
      `INSERT INTO trx_shipment_plan
        (company_id, plan_no, planned_date, buyer_id, shipment_type, mode, destination,
         total_packages, total_qty, net_weight_kg, gross_weight_kg, total_cbm, status, remarks, created_by,
         packing_list_id, so_id, io_no, package_basis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, body.planned_date, body.buyer_id ?? pl?.buyer_id ?? null,
       pl && !req.body?.shipment_type ? (pl.shipment_type ?? body.shipment_type) : body.shipment_type, body.mode,
       body.destination ?? pl?.destination ?? pl?.final_destination ?? null, t.packages, t.qty, t.net, t.gross, t.cbm,
       'DRAFT', body.remarks ?? null, req.user!.id, pl?.id ?? null, pl?.so_id ?? null, pl?.io_no ?? null, src.basis]);

    const planId = r.insertId;
    for (const c of src.cartons) {
      await txExecute(tx, `INSERT INTO trx_shipment_plan_package (plan_id, carton_id) VALUES (?,?)`, [planId, c.id]);
    }
    return txQueryOne(tx, `SELECT * FROM trx_shipment_plan WHERE id = ?`, [planId]);
  });

  res.status(201).json({ data: result });
}));

/** POST /shipment-plans/:id/convert — Convert plan directly to Draft Shipment */
shipmentRouter.post('/shipment-plans/:id/convert', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const planId = Number(req.params.id);

  const shipment = await transaction(async (tx) => {
    const plan = await txQueryOne<any>(tx,
      `SELECT * FROM trx_shipment_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [planId, cid]);
    if (!plan) throw NotFound('Shipment plan not found');
    if (plan.status === 'CONVERTED' || plan.status === 'CANCELLED') throw BadRequest(`Plan ${plan.plan_no} is already ${plan.status}`);
    const pkgs = await txQuery<any>(tx, `SELECT carton_id FROM trx_shipment_plan_package WHERE plan_id = ?`, [planId]);
    // re-checked now: list still CONFIRMED, cartons still READY and not shipped elsewhere
    const src = await resolveShipmentSource(tx, cid, plan.packing_list_id, pkgs.map((p: any) => Number(p.carton_id)));
    const pl = src.pl;
    const t = src.totals;
    const shipNo = await nextShipmentNo(tx, cid);
    const r = await txExecute(tx,
      `INSERT INTO trx_shipment
        (company_id, shipment_no, buyer_id, shipment_type, mode, destination,
         total_packages, total_qty, net_weight_kg, gross_weight_kg, total_cbm, remarks, created_by,
         packing_list_id, so_id, io_no, consignee_id, invoice_id, pol, pod, package_basis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, shipNo, plan.buyer_id ?? pl?.buyer_id ?? null, plan.shipment_type, plan.mode, plan.destination,
       t.packages, t.qty, t.net, t.gross, t.cbm, `Converted from Plan ${plan.plan_no}`, req.user!.id,
       pl?.id ?? null, plan.so_id ?? pl?.so_id ?? null, plan.io_no ?? pl?.io_no ?? null, pl?.consignee_id ?? null,
       pl?.invoice_id ?? null, pl?.port_of_loading ?? null, pl?.port_of_discharge ?? null, src.basis]);
    const shipId = r.insertId;

    for (const c of src.cartons) {
      await txExecute(tx,
        `INSERT INTO trx_shipment_package (shipment_id, carton_id, packing_id, package_no, allocated_qty, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?)`, [shipId, c.id, c.packing_id, c.carton_no, c.qty, c.gross, c.cbm]);
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
  const listBased = ship.package_basis === 'PACKING_LIST' && Number(ship.total_packages || 0) > 0;
  if (!pkgCount?.c && !listBased) throw BadRequest('Cannot release shipment without allocated packages');

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
  // dispatched cartons need a return / reversal, not a cancel (developer doc §20)
  const gone = await queryOne<any>(
    `SELECT COUNT(*) AS n FROM trx_shipment_package WHERE shipment_id = ? AND status IN ('DISPATCHED','DELIVERED')`, [id]);
  const disp = await queryOne<any>(`SELECT dispatch_no FROM trx_dispatch WHERE shipment_id = ? AND company_id = ? LIMIT 1`, [id, cid]);
  if (Number(gone?.n || 0) > 0 || disp) throw BadRequest(`Shipment ${ship.shipment_no} is already dispatched${disp ? ` (${disp.dispatch_no})` : ''} and cannot be cancelled`);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_shipment_package SET status = 'CANCELLED' WHERE shipment_id = ?`, [id]);
    await txExecute(tx,
      `UPDATE trx_shipment SET tracking_status = 'BOOKED', remarks = CONCAT(COALESCE(remarks,''), ' [CANCELLED]') WHERE id = ?`, [id]);
  });

  res.json({ data: { id, status: 'CANCELLED' } });
}));

