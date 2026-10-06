import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound, Conflict } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { settingFlag } from '../../core/inwardControls.js';
import type { Tx } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';

export const styleRouter = Router();

/** GET /styles/size-catalog — every active size once per code (the size master; a code in several groups is listed once). */
styleRouter.get('/size-catalog', requirePermission('STYLE.VIEW'), ah(async (_req, res) => {
  const rows = await query<any>(
    `SELECT sz.id, sz.size_code, sz.size_label, sz.sort_order, g.group_code, g.group_name
       FROM mst_size sz LEFT JOIN mst_size_group g ON g.id = sz.size_group_id
      WHERE sz.is_active = 1 AND (g.id IS NULL OR g.is_active = 1) ORDER BY sz.sort_order, sz.size_code, sz.id`);
  const byCode = new Map<string, any>();
  for (const r of rows) {
    const k = String(r.size_code).toUpperCase();
    if (!byCode.has(k)) byCode.set(k, { ...r, groups: [r.group_name ?? r.group_code ?? '—'], ids: [Number(r.id)] });
    else { const x = byCode.get(k); x.groups.push(r.group_name ?? r.group_code ?? '—'); x.ids.push(Number(r.id)); }
  }
  res.json({ data: [...byCode.values()] });
}));

/** POST /styles/size-catalog { size_code, size_label } — a new size in the size master (once per code) */
styleRouter.post('/size-catalog', requireAny('SIZE.CREATE', 'STYLE.UPDATE'), ah(async (req, res) => {
  const b = z.object({ size_code: s.strReq(20), size_label: s.nullableStr(40) }).parse(req.body ?? {});
  const code = b.size_code.trim().toUpperCase();
  const hit = await queryOne<any>(`SELECT id FROM mst_size WHERE UPPER(size_code) = ? ORDER BY is_active DESC, id LIMIT 1`, [code]);
  if (hit) { res.json({ data: { id: Number(hit.id), size_code: code, existed: true } }); return; }
  const id = await transaction(async (tx) => {
    let g = await txQueryOne<any>(tx, `SELECT id FROM mst_size_group WHERE company_id = ? AND group_code = 'GLOBAL'`, [req.user!.companyId]);
    if (!g) {
      const r = await txExecute(tx, `INSERT INTO mst_size_group (company_id, group_code, group_name, description, is_active) VALUES (?, 'GLOBAL', 'Global sizes', 'Sizes added from a style or order', 1)`, [req.user!.companyId]);
      g = { id: r.insertId };
    }
    const mx = await txQueryOne<any>(tx, `SELECT COALESCE(MAX(sort_order),0) m FROM mst_size WHERE size_group_id = ?`, [g.id]);
    const r = await txExecute(tx, `INSERT INTO mst_size (size_group_id, size_code, size_label, sort_order, is_active) VALUES (?,?,?,?,1)`, [g.id, code, b.size_label || code, Number(mx?.m) + 1]);
    return Number(r.insertId);
  });
  await audit(req, 'mst_size', id, 'INSERT', undefined, { size_code: code });
  res.status(201).json({ data: { id, size_code: code, existed: false } });
}));


const styleSchema = z.object({
  style_code: s.strReq(50),
  style_name: s.strReq(150),
  product_id: s.idReq(),
  buyer_id: s.id(),
  buyer_style_ref: s.nullableStr(80),
  season: s.nullableStr(40),
  size_group_id: s.id(),
  fabric_id: s.id(),
  description: s.text(),
  image_url: s.nullableStr(2000),
  status_id: s.id(),
  is_active: s.bool(),
  colorIds: z.array(z.coerce.number().int().positive()).optional(),
});

const SKU_SELECT = `
  SELECT k.*, c.color_name, c.color_code, c.hex_value,
         sz.size_code, sz.size_label, sz.sort_order AS size_sort
    FROM mst_style_sku k
    JOIN mst_color c ON c.id = k.color_id
    JOIN mst_size sz ON sz.id = k.size_id
   WHERE k.style_id = ?
   ORDER BY c.color_name, sz.sort_order, sz.id`;

// ---------------------------------------------------------------- LIST
styleRouter.get('/', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    buyer_id: z.coerce.number().int().optional(),
    product_id: z.coerce.number().int().optional(),
    season: z.string().trim().optional(),
    status_id: z.coerce.number().int().optional(),
    includeInactive: z.coerce.boolean().default(false),
  }).parse(req.query);

  const where = ['t.company_id = ?', 't.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (!q.includeInactive) where.push('t.is_active = 1');
  if (q.q) {
    where.push('(t.style_code LIKE ? OR t.style_name LIKE ? OR t.buyer_style_ref LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  for (const k of ['buyer_id', 'product_id', 'status_id', 'season'] as const) {
    if ((q as any)[k] !== undefined) { where.push(`t.${k} = ?`); params.push((q as any)[k]); }
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(
      `SELECT t.*, p.product_name, p.product_type, b.party_name AS buyer_name,
              fb.fabric_name, sg.group_name AS size_group_name, cs.label AS status_label,
              (SELECT COUNT(*) FROM mst_style_sku k WHERE k.style_id = t.id) AS sku_count
         FROM mst_style t
         LEFT JOIN mst_product p    ON p.id  = t.product_id
         LEFT JOIN mst_party b      ON b.id  = t.buyer_id
         LEFT JOIN mst_fabric fb    ON fb.id = t.fabric_id
         LEFT JOIN mst_size_group sg ON sg.id = t.size_group_id
         LEFT JOIN cfg_status cs    ON cs.id = t.status_id
        WHERE ${clause}
        ORDER BY t.style_code
        LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM mst_style t WHERE ${clause}`, params),
  ]);

  res.json({
    data: rows,
    pagination: { page: q.page, pageSize: q.pageSize, total: total?.total ?? 0,
      totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) },
  });
}));

// ------------------------------------------------------------- GET ONE
styleRouter.get('/:id', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const style = await queryOne(
    `SELECT t.*, p.product_name, b.party_name AS buyer_name, fb.fabric_name,
            sg.group_name AS size_group_name, cs.label AS status_label
       FROM mst_style t
       LEFT JOIN mst_product p ON p.id = t.product_id
       LEFT JOIN mst_party b   ON b.id = t.buyer_id
       LEFT JOIN mst_fabric fb ON fb.id = t.fabric_id
       LEFT JOIN mst_size_group sg ON sg.id = t.size_group_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!style) throw NotFound('Style not found');

  const [colors, skus, boms, techpacks] = await Promise.all([
    query(`SELECT sc.color_id AS id, c.color_code, c.color_name, c.hex_value
             FROM map_style_color sc JOIN mst_color c ON c.id = sc.color_id
            WHERE sc.style_id = ? ORDER BY c.color_name`, [id]),
    query(SKU_SELECT, [id]),
    query(`SELECT b.*, cs.label AS status_label, so.so_no, so.buyer_po_no FROM trx_bom b
             LEFT JOIN trx_sales_order so ON so.id = b.so_id
             LEFT JOIN cfg_status cs ON cs.id = b.status_id
            WHERE b.style_id = ? ORDER BY b.version DESC`, [id]),
    query(`SELECT * FROM trx_techpack WHERE style_id = ? ORDER BY version DESC`, [id]),
  ]);

  res.json({ data: { ...style, colors, skus, boms, techpacks, sizes: await styleSizes(null, id) } });
}));

// -------------------------------------------------------------- CREATE
styleRouter.post('/', requirePermission('STYLE.CREATE'), ah(async (req, res) => {
  const { colorIds, ...data } = styleSchema.parse(req.body);

  const created = await transaction(async (tx) => {
    const cols = { ...data, company_id: req.user!.companyId, created_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    const r = await txExecute(tx,
      `INSERT INTO mst_style (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => (cols as any)[k]));
    const styleId = r.insertId;

    if (colorIds?.length) {
      for (const cid of colorIds) {
        await txExecute(tx, `INSERT INTO map_style_color (style_id, color_id) VALUES (?,?)`, [styleId, cid]);
      }
    }
    // a size group on a new style fills its size assignment (the group is a shortcut — sizes can be changed one by one)
    if (data.size_group_id) await assignGroup(tx, req, styleId, Number(data.size_group_id), true);
    return txQueryOne(tx, `SELECT * FROM mst_style WHERE id = ?`, [styleId]);
  });

  await audit(req, 'mst_style', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// -------------------------------------------------------------- UPDATE
styleRouter.put('/:id', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Style not found');

  const partial = styleSchema.partial();
  const { colorIds, ...data } = partial.parse(req.body);

  const after = await transaction(async (tx) => {
    const cols = { ...data, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE mst_style SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => (cols as any)[k]), id, req.user!.companyId]);
    }

    if (colorIds) {
      // Removing a colorway must not orphan SKUs that are already in use.
      const existing = await txQuery<{ color_id: number }>(
        tx,
        `SELECT color_id FROM map_style_color WHERE style_id = ?`, [id]);
      const removed = existing.map((e) => e.color_id).filter((c) => !colorIds.includes(c));
      if (removed.length) {
        // a colour whose SKUs are on a sales order cannot go; unused SKUs are deactivated by the SKU sync
        const used = await txQueryOne<{ n: number }>(
          tx,
          `SELECT COUNT(*) AS n FROM mst_style_sku k JOIN trx_sales_order_sku sos ON sos.sku_id = k.id
            WHERE k.style_id = ? AND k.color_id IN (${removed.map(() => '?').join(',')})`,
          [id, ...removed]);
        if ((used?.n ?? 0) > 0) {
          throw Conflict('Cannot remove a colorway that is already on a sales order.');
        }
      }
      await txExecute(tx, `DELETE FROM map_style_color WHERE style_id = ?`, [id]);
      for (const cid of colorIds) {
        await txExecute(tx, `INSERT INTO map_style_color (style_id, color_id) VALUES (?,?)`, [id, cid]);
      }
    }
    // client 05-Oct-2026: changing the size group of a saved style changes its sizes and its SKUs
    // (before, the first group's SKUs stayed for ever)
    const oldGroup = (before as any).size_group_id ? Number((before as any).size_group_id) : null;
    if (data.size_group_id !== undefined && (data.size_group_id ?? null) !== oldGroup && data.size_group_id) {
      await assignGroup(tx, req, id, Number(data.size_group_id), true);
    }
    if (colorIds || (data.size_group_id !== undefined && (data.size_group_id ?? null) !== oldGroup)) {
      const st = await txQueryOne<any>(tx, `SELECT style_code FROM mst_style WHERE id = ?`, [id]);
      const hasSkus = await txQueryOne<any>(tx, `SELECT COUNT(*) n FROM mst_style_sku WHERE style_id = ?`, [id]);
      if (Number(hasSkus?.n) > 0) await syncSkus(tx, id, st.style_code);
    }
    return txQueryOne(tx, `SELECT * FROM mst_style WHERE id = ?`, [id]);
  });

  await audit(req, 'mst_style', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

styleRouter.delete('/:id', requirePermission('STYLE.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Style not found');
  await transaction((tx) => txExecute(tx,
    `UPDATE mst_style SET is_deleted = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]));
  await audit(req, 'mst_style', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

// ------------------------------------------------------- SKU generation
/**
 * Generate the SKU matrix for a style: every mapped colorway x every size assigned to the style (size doc §6; the
 * style's size group fills the assignment when it is empty). SKUs of sizes / colours no longer on the style are
 * deactivated (kept for history, hidden from new orders); existing SKUs are kept.
 */
styleRouter.post('/:id/generate-skus', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const style = await queryOne<{ id: number; style_code: string; size_group_id: number | null }>(
    `SELECT id, style_code, size_group_id FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!style) throw NotFound('Style not found');
  const colors = await query<any>(`SELECT color_id FROM map_style_color WHERE style_id = ?`, [id]);
  if (!colors.length) throw BadRequest('Add at least one colorway before generating SKUs');
  const r = await transaction(async (tx) => {
    let sizes = await styleSizes(tx, id);
    if (!sizes.length && style.size_group_id) { await assignGroup(tx, req, id, Number(style.size_group_id), false); sizes = await styleSizes(tx, id); }
    if (!sizes.length) throw BadRequest('Assign the sizes of this style first (Sizes: add sizes or a size group)');
    return syncSkus(tx, id, style.style_code);
  });
  const skus = await query(SKU_SELECT, [id]);
  res.json({ data: { created: r.added, reactivated: r.reactivated, deactivated: r.deactivated, total: skus.length, skus } });
}));

styleRouter.get('/:id/skus', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  res.json({ data: await query(SKU_SELECT, [Number(req.params.id)]) });
}));

/* ================================================================ style size assignment (size doc §6–§9, audio 4 + 6)
 * The sizes valid for a style are picked one by one from the size master (any group); a size group is only a shortcut
 * that fills the list. SKUs follow the assignment. Every change is logged (old, new, user, time, reason). */

export async function styleSizes(tx: Tx | null, styleId: number) {
  const sql = `SELECT ss.id, ss.size_id, ss.sequence_no, ss.is_default, ss.source_type, ss.source_group_id, sz.size_code, sz.size_label,
                      g.group_code, g.group_name
                 FROM mst_style_size ss JOIN mst_size sz ON sz.id = ss.size_id LEFT JOIN mst_size_group g ON g.id = sz.size_group_id
                WHERE ss.style_id = ? AND ss.is_active = 1 ORDER BY ss.sequence_no, sz.sort_order, ss.id`;
  return tx ? txQuery<any>(tx, sql, [styleId]) : query<any>(sql, [styleId]);
}

async function logSize(tx: Tx, req: any, styleId: number, action: string, sizeId: number | null, oldV: string | null, newV: string | null, reason?: string | null, soId?: number | null) {
  await txExecute(tx, `INSERT INTO trx_style_size_log (company_id, style_id, size_id, action, old_value, new_value, reason, so_id, user_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, styleId, sizeId, action, oldV, newV, reason ?? null, soId ?? null, req.user!.id]);
}

/** Put sizes on a style (active, in this order after the existing ones). Rejects a second size with the same code. */
async function addSizes(tx: Tx, req: any, styleId: number, sizeIds: number[], source: string, groupId: number | null, reason?: string | null, soId?: number | null) {
  const cur = await txQuery<any>(tx, `SELECT ss.size_id, ss.is_active, ss.sequence_no, sz.size_code FROM mst_style_size ss JOIN mst_size sz ON sz.id = ss.size_id WHERE ss.style_id = ?`, [styleId]);
  let seq = cur.filter((c) => c.is_active).reduce((a, c) => Math.max(a, Number(c.sequence_no)), 0);
  const added: any[] = [];
  for (const sid of sizeIds) {
    const sz = await txQueryOne<any>(tx, `SELECT id, size_code, is_active FROM mst_size WHERE id = ?`, [sid]);
    if (!sz) throw NotFound(`Size #${sid} not found`);
    if (!sz.is_active) throw BadRequest(`Size ${sz.size_code} is inactive`);
    const same = cur.find((c) => Number(c.size_id) === sid);
    if (same?.is_active) continue;
    const clash = cur.find((c) => c.is_active && Number(c.size_id) !== sid && String(c.size_code).toUpperCase() === String(sz.size_code).toUpperCase());
    if (clash) throw BadRequest(`The style already has a size ${sz.size_code} (from another size group)`);
    seq += 1;
    if (same) await txExecute(tx, `UPDATE mst_style_size SET is_active = 1, sequence_no = ?, source_type = ?, source_group_id = ? WHERE style_id = ? AND size_id = ?`, [seq, source, groupId, styleId, sid]);
    else await txExecute(tx, `INSERT INTO mst_style_size (style_id, size_id, sequence_no, source_type, source_group_id, created_by) VALUES (?,?,?,?,?,?)`, [styleId, sid, seq, source, groupId, req.user!.id]);
    cur.push({ size_id: sid, is_active: 1, sequence_no: seq, size_code: sz.size_code });
    await logSize(tx, req, styleId, source === 'ORDER' ? 'ORDER_ADD' : 'ADD', sid, null, sz.size_code, reason, soId);
    added.push(sz.size_code);
  }
  return added;
}

/** Fill the style's sizes from a size group; `replace` drops the sizes that are not in the group. */
async function assignGroup(tx: Tx, req: any, styleId: number, groupId: number, replace: boolean) {
  const sizes = await txQuery<any>(tx, `SELECT id, size_code FROM mst_size WHERE size_group_id = ? AND is_active = 1 ORDER BY sort_order, id`, [groupId]);
  if (replace) {
    const keep = sizes.map((x) => Number(x.id));
    const drop = await txQuery<any>(tx, `SELECT ss.size_id, sz.size_code FROM mst_style_size ss JOIN mst_size sz ON sz.id = ss.size_id WHERE ss.style_id = ? AND ss.is_active = 1`, [styleId]);
    for (const d of drop.filter((x) => !keep.includes(Number(x.size_id)))) {
      await txExecute(tx, `UPDATE mst_style_size SET is_active = 0 WHERE style_id = ? AND size_id = ?`, [styleId, d.size_id]);
      await logSize(tx, req, styleId, 'REMOVE', Number(d.size_id), d.size_code, null, `Size group changed`);
    }
  }
  const added = await addSizes(tx, req, styleId, sizes.map((x) => Number(x.id)), 'GROUP', groupId);
  // keep the group's order
  let i = 0;
  for (const sz of sizes) await txExecute(tx, `UPDATE mst_style_size SET sequence_no = ? WHERE style_id = ? AND size_id = ?`, [++i, styleId, sz.id]);
  return added;
}

/** SKUs = active colours × active sizes: missing ones added, old ones reactivated, the rest deactivated. */
export async function syncSkus(tx: Tx, styleId: number, styleCode: string) {
  const colors = await txQuery<any>(tx, `SELECT sc.color_id, c.color_code FROM map_style_color sc JOIN mst_color c ON c.id = sc.color_id WHERE sc.style_id = ?`, [styleId]);
  const sizes = await styleSizes(tx, styleId);
  const existing = await txQuery<any>(tx, `SELECT id, color_id, size_id, is_active FROM mst_style_sku WHERE style_id = ?`, [styleId]);
  const want = new Set<string>();
  let added = 0; let reactivated = 0; let deactivated = 0;
  for (const c of colors) {
    for (const sz of sizes) {
      const key = `${c.color_id}:${sz.size_id}`;
      want.add(key);
      const ex = existing.find((e) => `${e.color_id}:${e.size_id}` === key);
      if (ex) { if (!ex.is_active) { await txExecute(tx, `UPDATE mst_style_sku SET is_active = 1 WHERE id = ?`, [ex.id]); reactivated++; } continue; }
      let code = `${styleCode}-${c.color_code}-${sz.size_code}`.toUpperCase().slice(0, 60);
      if (await txQueryOne(tx, `SELECT id FROM mst_style_sku WHERE sku_code = ?`, [code])) code = `${code.slice(0, 50)}-${sz.size_id}`;
      await txExecute(tx, `INSERT INTO mst_style_sku (style_id, color_id, size_id, sku_code) VALUES (?,?,?,?)`, [styleId, c.color_id, sz.size_id, code]);
      added++;
    }
  }
  for (const e of existing) {
    if (e.is_active && !want.has(`${e.color_id}:${e.size_id}`)) { await txExecute(tx, `UPDATE mst_style_sku SET is_active = 0 WHERE id = ?`, [e.id]); deactivated++; }
  }
  return { added, reactivated, deactivated };
}

async function lockStyle(tx: Tx, cid: number, id: number) {
  const st = await txQueryOne<any>(tx, `SELECT id, style_code FROM mst_style WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
  if (!st) throw NotFound('Style not found');
  return st;
}
const hasSkus = async (tx: Tx, id: number) => Number((await txQueryOne<any>(tx, `SELECT COUNT(*) n FROM mst_style_sku WHERE style_id = ?`, [id]))?.n) > 0;

styleRouter.get('/:id/sizes', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const st = await queryOne<any>(`SELECT version_no FROM mst_style WHERE id = ?`, [id]);
  const log = await query<any>(`SELECT l.*, sz.size_code, u.full_name AS user_name FROM trx_style_size_log l LEFT JOIN mst_size sz ON sz.id = l.size_id
    LEFT JOIN mst_user u ON u.id = l.user_id WHERE l.style_id = ? ORDER BY l.id DESC LIMIT 100`, [id]);
  res.json({ data: await styleSizes(null, id), log, version_no: st?.version_no || 1 });
}));

/** PUT /styles/:id/sizes { sizes: [{ size_id, is_default? }] in order, reason? } — the full size list of the style */
styleRouter.put('/:id/sizes', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ sizes: z.array(z.object({ size_id: z.coerce.number().int().positive(), is_default: z.coerce.boolean().optional() })), reason: s.nullableStr(255) }).parse(req.body ?? {});
  const ids = b.sizes.map((x) => x.size_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('A size is listed twice');
  const out = await transaction(async (tx) => {
    const st = await lockStyle(tx, cid, id);
    const before = await styleSizes(tx, id);
    for (const r of before.filter((x) => !ids.includes(Number(x.size_id)))) {
      await txExecute(tx, `UPDATE mst_style_size SET is_active = 0 WHERE style_id = ? AND size_id = ?`, [id, r.size_id]);
      await logSize(tx, req, id, 'REMOVE', Number(r.size_id), r.size_code, null, b.reason);
    }
    await addSizes(tx, req, id, ids.filter((x) => !before.some((r) => Number(r.size_id) === x)), 'MANUAL', null, b.reason);
    let seq = 0;
    for (const x of b.sizes) await txExecute(tx, `UPDATE mst_style_size SET sequence_no = ?, is_default = ? WHERE style_id = ? AND size_id = ?`, [++seq, x.is_default ? 1 : 0, id, x.size_id]);
    const order = (rs: any[]) => rs.map((r) => r.size_code).join(',');
    const after = await styleSizes(tx, id);
    if (order(before.filter((r) => ids.includes(Number(r.size_id)))) !== order(after.filter((r) => before.some((x) => Number(x.size_id) === Number(r.size_id))))) {
      await logSize(tx, req, id, 'REORDER', null, order(before), order(after), b.reason);
    }
    // Increment style version number on size modification (Audio 1: v1, v2)
    await txExecute(tx, `UPDATE mst_style SET version_no = COALESCE(version_no, 1) + 1 WHERE id = ?`, [id]);
    const updatedSt = await txQueryOne<any>(tx, `SELECT version_no FROM mst_style WHERE id = ?`, [id]);
    const sync = (await hasSkus(tx, id)) ? await syncSkus(tx, id, st.style_code) : null;
    return { sizes: after, sync, version_no: updatedSt?.version_no || 1 };
  });
  await audit(req, 'mst_style', id, 'UPDATE', undefined, { sizes: out.sizes.map((x: any) => x.size_code), reason: b.reason, sku_sync: out.sync, version_no: out.version_no });
  res.json({ data: out });
}));

/** POST /styles/:id/sizes/group { size_group_id, replace? } — import a size group's sizes (shortcut) */
styleRouter.post('/:id/sizes/group', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ size_group_id: z.coerce.number().int().positive(), replace: z.coerce.boolean().default(false) }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const st = await lockStyle(tx, cid, id);
    const added = await assignGroup(tx, req, id, b.size_group_id, b.replace);
    const sync = (await hasSkus(tx, id)) ? await syncSkus(tx, id, st.style_code) : null;
    return { added, sizes: await styleSizes(tx, id), sync };
  });
  await audit(req, 'mst_style', id, 'UPDATE', undefined, { size_group_import: b.size_group_id, added: out.added });
  res.json({ data: out });
}));

/**
 * POST /styles/:id/sizes/order-add { size_id, so_id?, reason } — a size the buyer asked for on an order that is not on
 * the style (size doc §9–§10): only when SO_ALLOW_ADDITIONAL_SIZE is on, with SALES_ORDER.ADD_SIZE and a reason; logged.
 * The size is added to the style and its SKUs are created, so the order's size matrix shows it.
 */
styleRouter.post('/:id/sizes/order-add', requirePermission('SALES_ORDER.ADD_SIZE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ size_id: z.coerce.number().int().positive(), so_id: s.id(), reason: s.strReq(255) }).parse(req.body ?? {});
  if (!(await settingFlag(cid, 'SO_ALLOW_ADDITIONAL_SIZE', true))) throw BadRequest('Adding a size on an order is switched off (Admin › Settings › SO_ALLOW_ADDITIONAL_SIZE)');
  const out = await transaction(async (tx) => {
    const st = await lockStyle(tx, cid, id);
    const added = await addSizes(tx, req, id, [b.size_id], 'ORDER', null, b.reason, b.so_id ?? null);
    const sync = await syncSkus(tx, id, st.style_code);
    return { added, sync };
  });
  await audit(req, 'mst_style', id, 'UPDATE', undefined, { order_add_size: b.size_id, so_id: b.so_id, reason: b.reason });
  res.status(201).json({ data: out });
}));
