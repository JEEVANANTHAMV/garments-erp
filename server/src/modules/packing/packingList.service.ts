import { query, queryOne, txExecute, txQuery, type Tx } from '../../config/db.js';
import {
  applyOrderQty, shippedGroups, summarise, sumRows, groupKeyOf,
  type BlockOut, type ComputedList, type RowOut, type ItemOut, type SummaryGroup, type PlType,
} from './packingListCalc.js';

/** mysql2 returns JSON columns already parsed; older rows / drivers may give a string. */
export function asJson<T>(v: unknown, fallback: T): T {
  if (v == null || v === '') return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return fallback; } }
  return v as T;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();

/** Rebuild the computed structure from the stored (already validated) rows. */
export async function loadStructure(plId: number, listHeaders: string[] | null, db: { tx?: Tx } = {}): Promise<ComputedList> {
  const q = <T = any>(sql: string, p: unknown[]) => (db.tx ? txQuery<T>(db.tx, sql, p) : query<T>(sql, p));
  const blocksDb = await q<any>(`SELECT * FROM trx_packing_list_block WHERE packing_list_id = ? ORDER BY block_no`, [plId]);
  const rowsDb = await q<any>(`SELECT * FROM trx_packing_list_row WHERE packing_list_id = ? ORDER BY sort_order, id`, [plId]);
  const itemsDb = await q<any>(`SELECT * FROM trx_packing_list_row_item WHERE packing_list_id = ? ORDER BY row_id, sort_order, id`, [plId]);

  const itemsByRow = new Map<number, ItemOut[]>();
  for (const it of itemsDb) {
    const arr = itemsByRow.get(it.row_id) ?? [];
    arr.push({
      so_id: num(it.so_id), order_no: it.order_no, style_id: num(it.style_id), style_no: it.style_no,
      style_name: it.style_name, color_id: num(it.color_id), colour: it.colour,
      size_qty: asJson(it.size_qty, {}), size_qty_per_ctn: asJson(it.size_qty_per_ctn, {}),
      unit_qty: Number(it.unit_qty), qty_per_ctn: Number(it.qty_per_ctn), total_qty: Number(it.total_qty),
    });
    itemsByRow.set(it.row_id, arr);
  }
  const blocks: BlockOut[] = blocksDb.map((b: any) => {
    const stored = asJson<string[] | null>(b.size_headers, null);
    const rows: RowOut[] = rowsDb.filter((r: any) => r.block_id === b.id).map((r: any) => ({
      id: r.id,
      row_type: r.row_type, ctn_from: Number(r.ctn_from), ctn_to: Number(r.ctn_to), no_of_ctns: Number(r.no_of_ctns),
      pcs_per_pack: num(r.pcs_per_pack), packs_per_ctn: num(r.packs_per_ctn),
      pcs_per_ctn: Number(r.pcs_per_ctn), total_qty: Number(r.total_qty),
      net_wt_per_ctn: num(r.net_wt_per_ctn), gross_wt_per_ctn: num(r.gross_wt_per_ctn),
      total_net_wt: Number(r.total_net_wt), total_gross_wt: Number(r.total_gross_wt),
      length_cm: num(r.length_cm), width_cm: num(r.width_cm), height_cm: num(r.height_cm),
      cbm_per_ctn: num(r.cbm_per_ctn), total_cbm: Number(r.total_cbm),
      remarks: r.remarks, source_carton_ids: asJson<number[] | null>(r.source_carton_ids, null),
      items: itemsByRow.get(r.id) ?? [],
    }));
    return {
      id: b.id,
      block_no: Number(b.block_no), label: b.label, size_headers: stored,
      effective_size_headers: stored?.length ? stored : (listHeaders ?? []),
      rows, ...sumRows(rows),
    } as BlockOut;
  });
  return { blocks, ...summarise(blocks), warnings: [] };
}

/** Replace the draft blocks/rows/items of a packing list with a computed set. */
export async function writeStructure(tx: Tx, cid: number, plId: number, c: ComputedList) {
  await txExecute(tx, `DELETE FROM trx_packing_list_row_item WHERE packing_list_id = ?`, [plId]);
  await txExecute(tx, `DELETE FROM trx_packing_list_row WHERE packing_list_id = ?`, [plId]);
  await txExecute(tx, `DELETE FROM trx_packing_list_block WHERE packing_list_id = ?`, [plId]);
  let sort = 0;
  for (const b of c.blocks) {
    const br = await txExecute(tx,
      `INSERT INTO trx_packing_list_block (company_id, packing_list_id, block_no, label, size_headers) VALUES (?,?,?,?,?)`,
      [cid, plId, b.block_no, b.label, b.size_headers ? JSON.stringify(b.size_headers) : null]);
    for (const r of b.rows) {
      sort += 1;
      const rr = await txExecute(tx,
        `INSERT INTO trx_packing_list_row
           (company_id, packing_list_id, block_id, sort_order, row_type, ctn_from, ctn_to, no_of_ctns,
            pcs_per_pack, packs_per_ctn, pcs_per_ctn, total_qty, net_wt_per_ctn, gross_wt_per_ctn,
            total_net_wt, total_gross_wt, length_cm, width_cm, height_cm, cbm_per_ctn, total_cbm,
            source_carton_ids, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, plId, br.insertId, sort, r.row_type, r.ctn_from, r.ctn_to, r.no_of_ctns,
         r.pcs_per_pack, r.packs_per_ctn, r.pcs_per_ctn, r.total_qty, r.net_wt_per_ctn, r.gross_wt_per_ctn,
         r.total_net_wt, r.total_gross_wt, r.length_cm, r.width_cm, r.height_cm, r.cbm_per_ctn, r.total_cbm,
         r.source_carton_ids ? JSON.stringify(r.source_carton_ids) : null, r.remarks]);
      let isort = 0;
      for (const it of r.items) {
        isort += 1;
        await txExecute(tx,
          `INSERT INTO trx_packing_list_row_item
             (company_id, packing_list_id, row_id, sort_order, so_id, order_no, style_id, style_no, style_name,
              color_id, colour, size_qty, size_qty_per_ctn, unit_qty, qty_per_ctn, total_qty)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [cid, plId, rr.insertId, isort, it.so_id, it.order_no, it.style_id, it.style_no, it.style_name,
           it.color_id, it.colour, JSON.stringify(it.size_qty), JSON.stringify(it.size_qty_per_ctn),
           it.unit_qty, it.qty_per_ctn, it.total_qty]);
      }
    }
  }
}

/**
 * Order / Shipped / Diff per order-style-colour. Order qty comes from the
 * sales order size breakdown (trx_sales_order_line → trx_sales_order_sku)
 * when the list or the item is linked to a sales order and the style/colour
 * can be matched; otherwise from the manual order-qty table.
 */
export async function buildSummary(cid: number, plId: number | null, headerSoId: number | null, c: ComputedList,
  manualOverride?: { group_key: string; size_label: string; order_qty: number }[]): Promise<SummaryGroup[]> {
  const groups = shippedGroups(c);
  if (!groups.length) return groups;

  const soIds = [...new Set(groups.map((g) => g.so_id ?? headerSoId).filter((x): x is number => !!x))];
  let soLines: any[] = [];
  if (soIds.length) {
    soLines = await query<any>(
      `SELECT l.so_id, l.style_id, st.style_code, st.style_name, st.buyer_style_ref,
              l.color_id, col.color_name, sz.size_code, sz.size_label, sz.sort_order, SUM(sk.qty) AS qty
         FROM trx_sales_order_line l
         JOIN trx_sales_order so ON so.id = l.so_id AND so.company_id = ?
         JOIN trx_sales_order_sku sk ON sk.so_line_id = l.id
         JOIN mst_style_sku k ON k.id = sk.sku_id
         JOIN mst_size sz ON sz.id = k.size_id
         LEFT JOIN mst_style st ON st.id = l.style_id
         LEFT JOIN mst_color col ON col.id = COALESCE(l.color_id, k.color_id)
        WHERE l.so_id IN (${soIds.map(() => '?').join(',')})
        GROUP BY l.so_id, l.style_id, st.style_code, st.style_name, st.buyer_style_ref, l.color_id, col.color_name,
                 sz.size_code, sz.size_label, sz.sort_order
        ORDER BY sz.sort_order`, [cid, ...soIds]);
  }
  const manual = manualOverride ?? (plId ? await query<any>(
    `SELECT group_key, size_label, order_qty FROM trx_packing_list_order_qty WHERE packing_list_id = ? AND company_id = ?`,
    [plId, cid]) : []);

  for (const g of groups) {
    const soId = g.so_id ?? headerSoId;
    const order: Record<string, number> = {};
    if (soId) {
      const styleKeys = [g.style_no, g.style_name].filter(Boolean).map(norm);
      for (const l of soLines) {
        if (Number(l.so_id) !== Number(soId)) continue;
        const styleOk = (g.style_id && Number(l.style_id) === g.style_id)
          || [l.style_code, l.buyer_style_ref, l.style_name].filter(Boolean).some((x: string) => styleKeys.includes(norm(x)));
        if (!styleOk) continue;
        const colourOk = (g.color_id && Number(l.color_id) === g.color_id) || norm(l.color_name) === norm(g.colour);
        if (!colourOk) continue;
        const label = g.sizes.find((h) => norm(h) === norm(l.size_code) || norm(h) === norm(l.size_label)) ?? l.size_code;
        order[label] = (order[label] || 0) + Number(l.qty || 0);
      }
    }
    if (Object.keys(order).length) { applyOrderQty(g, order, 'SALES_ORDER'); continue; }
    const m = manual.filter((x: any) => x.group_key === g.group_key);
    if (m.length) {
      const o: Record<string, number> = {};
      for (const x of m) o[x.size_label] = (o[x.size_label] || 0) + Number(x.order_qty);
      applyOrderQty(g, o, 'MANUAL');
    } else applyOrderQty(g, {}, 'NONE');
  }
  return groups;
}

export { groupKeyOf };

/** Exporter block default from the company master. */
export async function companyExporterDetails(cid: number): Promise<string | null> {
  const c = await queryOne<any>(
    `SELECT c.trade_name, c.legal_name, c.address_line1, c.address_line2, c.city, c.pincode, c.gstin, c.iec_code,
            ct.name AS country
       FROM mst_company c LEFT JOIN cfg_country ct ON ct.id = c.country_id WHERE c.id = ?`, [cid]);
  if (!c) return null;
  const cityLine = [c.city, c.pincode].filter(Boolean).join(' - ');
  return [c.trade_name || c.legal_name, c.address_line1, c.address_line2,
          [cityLine, c.country ? String(c.country).toUpperCase() : null].filter(Boolean).join('. '),
          c.gstin ? `GST NO: ${c.gstin}` : null].filter(Boolean).join('\n');
}

/** Party name + default address as a multi-line block (consignee / notify). */
export async function partyAddressBlock(cid: number, partyId: number | null): Promise<string | null> {
  if (!partyId) return null;
  const p = await queryOne<any>(`SELECT id, party_name FROM mst_party WHERE id = ? AND company_id = ?`, [partyId, cid]);
  if (!p) return null;
  const a = await queryOne<any>(
    `SELECT pa.address_line1, pa.address_line2, pa.address_line3, pa.city, pa.pincode, ct.name AS country
       FROM mst_party_address pa LEFT JOIN cfg_country ct ON ct.id = pa.country_id
      WHERE pa.party_id = ? AND pa.is_active = 1 ORDER BY pa.is_default DESC, pa.id LIMIT 1`, [partyId]);
  return [p.party_name, a?.address_line1, a?.address_line2, a?.address_line3,
          [a?.pincode, a?.city].filter(Boolean).join(' '), a?.country ? String(a.country).toUpperCase() : null]
    .filter(Boolean).join('\n');
}

export type { PlType };
