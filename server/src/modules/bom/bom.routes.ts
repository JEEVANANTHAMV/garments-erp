import { Router } from 'express';
import { z } from 'zod';
import { withMaterialRates, materialRates } from '../../core/materialRate.js';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { orderCells, cellsFor, cellsPlanCut, cellsOrderQty, lineRequirement, type OrderCell } from '../../core/bomRequirement.js';

export const bomRouter = Router();

const lineSchema = z.object({
  material_type: z.enum(['YARN', 'FABRIC', 'TRIM', 'ACCESSORY', 'PACKING', 'GENERAL']),
  yarn_id: s.id(), fabric_id: s.id(), trim_id: s.id(),
  item_description: s.nullableStr(255),
  color_id: s.id(), size_id: s.id(),
  consumption_basis: z.string().default('PER_PIECE'),
  applicability: z.string().default('ALL'),
  consumption: z.coerce.number().positive('Consumption must be greater than zero'),
  additional_qty: z.coerce.number().min(0).default(0),
  uom_id: s.idReq(),
  wastage_pct: z.coerce.number().min(0).max(100).default(0),
  /** Free-text spec typed next to the material (e.g. poly bag 12x16 in, care label "100% Cotton"); printed on the BOM. */
  specification: s.nullableStr(255),
  /** Fabric: Dia (Dia master) and GSM (GSM master). */
  dia: s.nullableStr(20),
  gsm: z.coerce.number().int().min(0).max(2000).nullish(),
  /** Yarn: base + count (Yarn Count master) — the base + count variant is resolved on save. */
  yarn_base_id: s.id(), yarn_count_id: s.id(),
  /** Fabric / yarn bought grey or dyed; the colour applies only when dyed. */
  dye_type: z.enum(['GREY', 'DYED']).nullish(),
  material_color_id: s.id(),
  remarks: s.nullableStr(255),
}).refine(
  (l) => (l.material_type === 'YARN' && (l.yarn_id || (l.yarn_base_id && l.yarn_count_id))) ||
         (l.material_type === 'FABRIC' && l.fabric_id) ||
         (l.material_type === 'TRIM' && l.trim_id) ||
         (['ACCESSORY', 'PACKING', 'GENERAL'].includes(l.material_type) && (l.trim_id || l.item_description)),
  { message: 'Select a material matching the chosen material type or provide item description' },
);

const bomSchema = z.object({
  style_id: s.idReq(),
  so_id: s.id().nullish(),
  bom_no: s.nullableStr(40),
  version: z.coerce.number().int().min(1).default(1),
  effective_date: s.date(),
  status_id: s.id(),
  approval_state: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'SUPERSEDED', 'CANCELLED']).default('DRAFT'),
  remarks: s.nullableStr(500),
  is_active: s.bool(),
  lines: z.array(lineSchema).default([]),
});

const LINE_SELECT = `
  SELECT l.*, y.yarn_name, y.yarn_code, fb.fabric_name, fb.fabric_code,
         tr.trim_name, tr.trim_code, c.color_name, sz.size_code, u.code AS uom_code,
         mc.color_name AS material_color_name, yc.count_value AS yarn_count_value, yc.count_type AS yarn_count_type,
         COALESCE(y.std_rate, fb.std_rate, tr.std_rate, 0) AS std_rate
    FROM trx_bom_line l
    LEFT JOIN mst_yarn y   ON y.id  = l.yarn_id
    LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
    LEFT JOIN mst_trim tr  ON tr.id = l.trim_id
    LEFT JOIN mst_color c  ON c.id  = l.color_id
    LEFT JOIN mst_size sz  ON sz.id = l.size_id
    LEFT JOIN cfg_uom u    ON u.id  = l.uom_id
    LEFT JOIN mst_color mc ON mc.id = l.material_color_id
    LEFT JOIN mst_yarn_count yc ON yc.id = l.yarn_count_id
   WHERE l.bom_id = ? ORDER BY l.material_type, l.id`;

bomRouter.get('/', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    style_id: z.coerce.number().int().optional(),
    so_id: z.coerce.number().int().optional(),
    q: z.string().trim().optional(),
  }).parse(req.query);

  const where = ['b.company_id = ?', 'b.is_active = 1'];
  const params: unknown[] = [req.user!.companyId];
  if (q.style_id) { where.push('b.style_id = ?'); params.push(q.style_id); }
  if (q.so_id)    { where.push('b.so_id = ?'); params.push(q.so_id); }
  if (q.q) {
    where.push('(b.bom_no LIKE ? OR st.style_code LIKE ? OR so.so_no LIKE ? OR so.buyer_po_no LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT b.*, st.style_code, st.style_name, cs.label AS status_label,
                  so.so_no, so.buyer_po_no,
                  (SELECT COUNT(*) FROM trx_bom_line l WHERE l.bom_id = b.id) AS line_count
             FROM trx_bom b
             LEFT JOIN mst_style st ON st.id = b.style_id
             LEFT JOIN trx_sales_order so ON so.id = b.so_id
             LEFT JOIN cfg_status cs ON cs.id = b.status_id
            WHERE ${clause} ORDER BY b.id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM trx_bom b
         LEFT JOIN mst_style st ON st.id = b.style_id
         LEFT JOIN trx_sales_order so ON so.id = b.so_id
        WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

/**
 * GET /for-job — BOM materials and requirement for a Job (Sales Order / IO No) and/or Style.
 * Used by Yarn, Fabric and Trim POs and by purchase Quotations ("Load from BOM").
 *
 * Query: so_id | io_no (matched on trx_sales_order.io_no, then so_no), optional style_id;
 *        order_qty only for a style without a job.
 * - The job's styles and quantities come from trx_sales_order_line: order qty of a style =
 *   SUM(plan_cut_qty), falling back to SUM(order_qty) when plan-cut is not entered.
 * - Per style the BOM linked to that SO (trx_bom.so_id) wins, else the style's generic BOM
 *   (so_id NULL); approved before draft, then the latest version. Cancelled / superseded
 *   BOMs are ignored.
 * - Colour-wise / size-wise BOM lines are multiplied by that colour's / size's plan-cut qty
 *   only (size split from trx_sales_order_sku scaled by the line's plan-cut ratio), not by
 *   the whole order.
 * Response keeps the shape the pages read: bom, order_qty, so, lines + yarns / fabrics / trims /
 * accessories / packings / generals with order_required_qty / final_requirement per line.
 */
bomRouter.get('/for-job', requireAny('BOM.VIEW', 'PURCHASE.VIEW', 'PROCUREMENT.VIEW', 'QUOTATION.VIEW'), ah(async (req, res) => {
  res.json({ success: true, data: await jobBomRequirement(req.user!.companyId, forJobQuery.parse(req.query)) });
}));

export const forJobQuery = z.object({
  so_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().min(1).max(60).optional(),
  style_id: z.coerce.number().int().positive().optional(),
  order_qty: z.coerce.number().min(0).optional(),
});

/**
 * The job's (or a style's) BOM exploded into material requirements — the figures MRP, POs, quotations and the
 * purchase excess limit all use: per BOM line the requirement for its colour / size cells of the plan cut.
 */
export async function jobBomRequirement(cid: number, q: z.infer<typeof forJobQuery>) {
  if (!q.so_id && !q.io_no && !q.style_id) throw BadRequest('Select a job (IO No) or a style to load its BOM');

  // 1. Resolve the job
  const SO_SELECT = `
    SELECT so.id, so.so_no, so.io_no, so.buyer_po_no, so.buyer_id, so.plan_cut_qty, so.order_qty,
           b.party_name AS buyer_name
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id`;
  let so: any = null;
  if (q.so_id) {
    so = await queryOne(`${SO_SELECT} WHERE so.id = ? AND so.company_id = ? AND so.is_deleted = 0`, [q.so_id, cid]);
    if (!so) throw NotFound('Job / sales order not found');
  } else if (q.io_no) {
    so = await queryOne(
      `${SO_SELECT} WHERE so.company_id = ? AND so.is_deleted = 0 AND (so.io_no = ? OR so.so_no = ?)
        ORDER BY (so.io_no = ?) DESC, so.id DESC LIMIT 1`, [cid, q.io_no, q.io_no, q.io_no]);
    if (!so) throw NotFound(`No job found for IO No "${q.io_no}"`);
  }
  const jobNo: string | null = so ? (so.io_no || so.so_no) : null;

  // 2. Styles to explode, with the quantity each one is planned to cut
  type StyleQty = { style_id: number; style_code: string; style_name: string; qty: number };
  let styles: StyleQty[];
  if (so) {
    const rows = await query<any>(
      `SELECT sol.style_id, st.style_code, st.style_name,
              SUM(COALESCE(sol.plan_cut_qty, 0)) AS plan_cut, SUM(COALESCE(sol.order_qty, 0)) AS ordered
         FROM trx_sales_order_line sol
         JOIN mst_style st ON st.id = sol.style_id
        WHERE sol.so_id = ?${q.style_id ? ' AND sol.style_id = ?' : ''}
        GROUP BY sol.style_id, st.style_code, st.style_name
        ORDER BY st.style_code`, q.style_id ? [so.id, q.style_id] : [so.id]);
    styles = rows.map((r) => ({
      style_id: Number(r.style_id), style_code: r.style_code, style_name: r.style_name,
      qty: Number(r.plan_cut) > 0 ? Number(r.plan_cut) : Number(r.ordered) || 0,
    }));
    if (!styles.length) {
      throw BadRequest(q.style_id
        ? `The selected style is not part of job ${jobNo}`
        : `Job ${jobNo} has no style lines — add styles to the sales order first`);
    }
  } else {
    const st = await queryOne<any>(
      'SELECT id, style_code, style_name FROM mst_style WHERE id = ? AND company_id = ?', [q.style_id, cid]);
    if (!st) throw NotFound('Style not found');
    styles = [{ style_id: Number(st.id), style_code: st.style_code, style_name: st.style_name, qty: q.order_qty ?? 0 }];
  }

  // 3. Colour / size cells of the job come per style from orderCells (plan cut incl. size-wise excess)

  // 4. Per style: pick the BOM, explode its lines
  const boms: any[] = [];
  const items: any[] = [];
  const warnings: string[] = [];
  for (const st of styles) {
    const bom = so
      ? await queryOne<any>(
        `SELECT b.*, st.style_code, st.style_name, so.so_no, so.io_no, so.buyer_po_no
           FROM trx_bom b
           LEFT JOIN mst_style st ON st.id = b.style_id
           LEFT JOIN trx_sales_order so ON so.id = b.so_id
          WHERE b.company_id = ? AND b.is_active = 1 AND b.style_id = ?
            AND COALESCE(b.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'SUPERSEDED')
            AND (b.so_id = ? OR b.so_id IS NULL)
          ORDER BY (b.so_id IS NOT NULL) DESC, (b.approval_state = 'APPROVED') DESC, b.version DESC, b.id DESC
          LIMIT 1`, [cid, st.style_id, so.id])
      : await queryOne<any>(
        `SELECT b.*, st.style_code, st.style_name, so.so_no, so.io_no, so.buyer_po_no
           FROM trx_bom b
           LEFT JOIN mst_style st ON st.id = b.style_id
           LEFT JOIN trx_sales_order so ON so.id = b.so_id
          WHERE b.company_id = ? AND b.is_active = 1 AND b.style_id = ?
            AND COALESCE(b.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'SUPERSEDED')
          ORDER BY (b.so_id IS NULL) DESC, (b.approval_state = 'APPROVED') DESC, b.version DESC, b.id DESC
          LIMIT 1`, [cid, st.style_id]);
    if (!bom) { warnings.push(`No active BOM for style ${st.style_code}`); continue; }
    boms.push({ ...bom, order_qty: st.qty });
    if (so && st.qty <= 0) warnings.push(`Style ${st.style_code}: plan-cut / order qty is zero on job ${jobNo}`);

    const [lines, specs] = await Promise.all([
      query<any>(LINE_SELECT, [bom.id]).then((r) => withMaterialRates(cid, r)),
      // Material specs the POs / quotations prefill (dia, GSM, count, composition …)
      query<any>(
        `SELECT l.id, fb.dia_inch AS fabric_dia, g.gsm_value AS fabric_gsm, fb.fabric_type AS fabric_master_type,
                fcomp.description AS fabric_composition,
                y.count_value, y.count_type, y.yarn_type AS yarn_master_type, ycomp.description AS yarn_composition,
                tr.specification AS trim_specification
           FROM trx_bom_line l
           LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
           LEFT JOIN mst_gsm g ON g.id = fb.gsm_id
           LEFT JOIN mst_composition fcomp ON fcomp.id = fb.composition_id
           LEFT JOIN mst_yarn y ON y.id = l.yarn_id
           LEFT JOIN mst_composition ycomp ON ycomp.id = y.composition_id
           LEFT JOIN mst_trim tr ON tr.id = l.trim_id
          WHERE l.bom_id = ?`, [bom.id]),
    ]);
    const specById = new Map(specs.map((sp) => [Number(sp.id), sp]));
    const cells: OrderCell[] = so ? await orderCells(null, Number(so.id), st.style_id) : [];

    for (const l of lines) {
      // Quantity this line applies to: whole style, or only its colour / size / colour-size cells
      const basisQty = so && (l.color_id || l.size_id) ? cellsPlanCut(cellsFor(l, cells)) : st.qty;
      const cons = Number(l.consumption) || 0;
      const waste = Number(l.wastage_pct) || 0;
      const req = lineRequirement(l, basisQty);
      const addl = req.addl;
      const baseQty = req.base;
      const wasteQty = req.waste;
      let finalReq = Number(req.required.toFixed(4));
      // Countable units are bought in whole numbers
      if (['PCS', 'NOS', 'PC', 'SET'].includes(String(l.uom_code || '').toUpperCase())) finalReq = Math.ceil(finalReq);
      const rate = Number(l.std_rate) || 0;
      const sp = specById.get(Number(l.id)) ?? {};
      items.push({
        ...l,
        ...sp,
        id: l.id,
        bom_line_id: l.id,
        bom_no: bom.bom_no,
        bom_version: bom.version,
        style_id: st.style_id,
        style_code: st.style_code,
        style_name: st.style_name,
        so_id: so ? Number(so.id) : null,
        job_no: jobNo,
        material_name: l.fabric_name || l.yarn_name || l.trim_name || l.item_description || '',
        yarn_count: l.yarn_count_value
          ? `${l.yarn_count_value}${l.yarn_count_type && l.yarn_count_type !== 'Ne' ? ` ${l.yarn_count_type}` : ''}`
          : sp.count_value ? `${sp.count_value}${sp.count_type && sp.count_type !== 'Ne' ? ` ${sp.count_type}` : ''}` : null,
        // Dia / GSM entered on the BOM line win over the fabric master's
        fabric_dia: l.dia ? (parseFloat(String(l.dia)) || sp.fabric_dia) : sp.fabric_dia,
        fabric_gsm: l.gsm || sp.fabric_gsm,
        // Colour to buy: the dyed colour of the fabric / yarn, else the garment colour of the line
        purchase_color_name: l.dye_type === 'DYED' ? (l.material_color_name || l.color_name || null) : (l.dye_type === 'GREY' ? null : l.color_name || null),
        consumption: cons,
        additional_qty: addl,
        wastage_pct: waste,
        order_qty: basisQty,
        base_qty: Number(baseQty.toFixed(4)),
        wastage_qty: Number(wasteQty.toFixed(4)),
        order_required_qty: finalReq,
        final_requirement: finalReq,
        std_rate: rate,
        estimated_amount: Number((finalReq * rate).toFixed(2)),
      });
    }
  }

  if (!boms.length) {
    throw NotFound(so
      ? `No active BOM found for job ${jobNo} (style ${styles.map((s2) => s2.style_code).join(', ')}). Create the BOM first.`
      : `No active BOM found for style ${styles[0].style_code}. Create the BOM first.`);
  }

  return {
    bom: boms[0],
    boms,
    so,
    job_no: jobNo,
    styles,
    order_qty: styles.reduce((t, s2) => t + s2.qty, 0),
    warnings,
    lines: items,
    yarns: items.filter((i) => i.material_type === 'YARN'),
    fabrics: items.filter((i) => i.material_type === 'FABRIC'),
    trims: items.filter((i) => i.material_type === 'TRIM'),
    accessories: items.filter((i) => i.material_type === 'ACCESSORY'),
    packings: items.filter((i) => i.material_type === 'PACKING'),
    generals: items.filter((i) => i.material_type === 'GENERAL'),
  };
}

/**
 * GET /order-cells?so_id=&style_id= — the job strip and requirement grid of the BOM screen:
 * job / buyer / style and the order's colour × size quantities (plan cut incl. size-wise excess),
 * the same cells MRP, for-job and the BOM print multiply BOM lines by.
 */
/**
 * GET /boms/material-rates?yarn_ids=1,2&fabric_ids=&trim_ids= — costing rate of each material with its source
 * (standard rate → latest accepted purchase quotation → latest PO), so the BOM screen prices lines the same way.
 */
bomRouter.get('/material-rates', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const ids = (k: string) => String(req.query[k] ?? '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const items = [...ids('yarn_ids').map((id) => ({ type: 'YARN' as const, id })), ...ids('fabric_ids').map((id) => ({ type: 'FABRIC' as const, id })),
    ...ids('trim_ids').map((id) => ({ type: 'TRIM' as const, id }))];
  const m = await materialRates(req.user!.companyId, items);
  res.json({ data: Object.fromEntries(m) });
}));

bomRouter.get('/order-cells', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ so_id: z.coerce.number().int().positive(), style_id: z.coerce.number().int().positive() }).parse(req.query);
  const so = await queryOne<any>(
    `SELECT so.id, so.so_no, so.io_no, so.buyer_po_no, b.party_name AS buyer_name, st.style_code, st.style_name
       FROM trx_sales_order so
       LEFT JOIN mst_party b ON b.id = so.buyer_id
       LEFT JOIN mst_style st ON st.id = ? AND st.company_id = so.company_id
      WHERE so.id = ? AND so.company_id = ? AND so.is_deleted = 0`, [q.style_id, q.so_id, cid]);
  if (!so) throw NotFound('Sales order not found');
  const cells = await orderCells(null, q.so_id, q.style_id);
  const ids = (k: 'color_id' | 'size_id') => [...new Set(cells.map((c) => c[k]).filter((v): v is number => v != null))];
  const [colors, sizes] = await Promise.all([
    ids('color_id').length ? query<any>('SELECT id, color_name AS name FROM mst_color WHERE id IN (?)', [ids('color_id')]) : [],
    ids('size_id').length ? query<any>('SELECT id, size_code AS code, sort_order FROM mst_size WHERE id IN (?) ORDER BY sort_order, id', [ids('size_id')]) : [],
  ]);
  const sum = (f: (c: OrderCell) => boolean) => {
    const xs = cells.filter(f);
    return { qty: cellsOrderQty(xs), plan_cut: cellsPlanCut(xs) };
  };
  res.json({
    data: {
      so_id: so.id, job_no: so.io_no || so.so_no, so_no: so.so_no, buyer_name: so.buyer_name, buyer_po_no: so.buyer_po_no,
      style_code: so.style_code, style_name: so.style_name,
      sizes: sizes.map((z: any) => ({ size_id: Number(z.id), code: z.code, ...sum((c) => c.size_id === Number(z.id)) })),
      colors: colors.map((c: any) => ({ color_id: Number(c.id), name: c.name, ...sum((x) => x.color_id === Number(c.id)) }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      totals: { qty: cellsOrderQty(cells), plan_cut: cellsPlanCut(cells) },
      cells,
    },
  });
}));

bomRouter.get('/:id', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const bom = await queryOne(
    `SELECT b.*, st.style_code, st.style_name, cs.label AS status_label,
            so.so_no, so.buyer_po_no
       FROM trx_bom b
       LEFT JOIN mst_style st ON st.id = b.style_id
       LEFT JOIN trx_sales_order so ON so.id = b.so_id
       LEFT JOIN cfg_status cs ON cs.id = b.status_id
      WHERE b.id = ? AND b.company_id = ?`, [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');
  res.json({ data: { ...bom, lines: await withMaterialRates(req.user!.companyId, await query<any>(LINE_SELECT, [id])) } });
}));

/**
 * GET /:id/print — everything the printable BOM needs: company, header (style,
 * buyer, SO / IO, order and plan-cut qty) and lines with their specification
 * and required quantity. Required qty is worked on the PLAN-CUT quantity
 * (order + excess, size-wise where given) of the colours / sizes each line
 * applies to; a master BOM (no SO) prints consumption only.
 */
bomRouter.get('/:id/print', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const cid = req.user!.companyId;
  const bom = await queryOne<any>(
    `SELECT b.*, st.style_code, st.style_name, cs.label AS status_label,
            so.so_no, so.io_no, so.buyer_po_no, so.so_date, so.ship_date AS so_ship_date,
            COALESCE(bso.party_name, bst.party_name) AS buyer_name,
            cu.full_name AS created_by_name, au.full_name AS approved_by_name
       FROM trx_bom b
       LEFT JOIN mst_style st ON st.id = b.style_id
       LEFT JOIN trx_sales_order so ON so.id = b.so_id
       LEFT JOIN mst_party bso ON bso.id = so.buyer_id
       LEFT JOIN mst_party bst ON bst.id = st.buyer_id
       LEFT JOIN cfg_status cs ON cs.id = b.status_id
       LEFT JOIN mst_user cu ON cu.id = b.created_by
       LEFT JOIN mst_user au ON au.id = b.approved_by
      WHERE b.id = ? AND b.company_id = ?`, [id, cid]);
  if (!bom) throw NotFound('BOM not found');

  const company = await queryOne<any>(
    `SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state, pincode, phone, email
       FROM mst_company WHERE id = ?`, [cid]);

  const lines = await withMaterialRates(req.user!.companyId, await query<any>(LINE_SELECT, [id]));

  let orderQty: number | null = null;
  let planCutQty: number | null = null;
  // (colour, size) cells of the order with their order / plan-cut qty (shared with MRP and the job BOM pick).
  let cells: OrderCell[] = [];
  if (bom.so_id) {
    cells = await orderCells(null, Number(bom.so_id), Number(bom.style_id));
    orderQty = cellsOrderQty(cells);
    planCutQty = cellsPlanCut(cells);
  }

  const items = lines.map((l) => {
    const applicableQty = planCutQty !== null ? cellsPlanCut(cellsFor(l, cells)) : null;
    const required = applicableQty !== null ? Number(lineRequirement(l, applicableQty).required.toFixed(4)) : null;
    return { ...l, applicable_qty: applicableQty, required_qty: required };
  });

  res.json({ data: { company, bom, order_qty: orderQty, plan_cut_qty: planCutQty, lines: items } });
}));

/**
 * Yarn variant (mst_yarn) of a yarn base + count: the existing one, else created from the
 * base (composition, type, HSN, UOM) — a base created in the Yarn master is usable on the
 * BOM without generating count variants first. POs / quotations / MRP keep using yarn_id.
 */
async function resolveYarnVariant(tx: any, cid: number, userId: number, baseId: number, countId: number): Promise<number> {
  const cnt = await txQueryOne<any>(tx, 'SELECT id, count_value, count_type FROM mst_yarn_count WHERE id = ? AND company_id = ?', [countId, cid]);
  if (!cnt) throw BadRequest('Yarn count not found');
  const base = await txQueryOne<any>(tx, 'SELECT * FROM mst_yarn_base WHERE id = ? AND company_id = ? AND is_deleted = 0', [baseId, cid]);
  if (!base) throw BadRequest('Yarn base not found');
  const hit = await txQueryOne<any>(tx,
    `SELECT id FROM mst_yarn
      WHERE company_id = ? AND yarn_base_id = ? AND is_deleted = 0
        AND (count_id = ? OR (count_id IS NULL AND count_value = ? AND COALESCE(count_type, 'Ne') = ?))
      ORDER BY (count_id = ?) DESC, is_active DESC, id LIMIT 1`,
    [cid, baseId, countId, cnt.count_value, cnt.count_type || 'Ne', countId]);
  if (hit) return Number(hit.id);
  const slug = String(cnt.count_value).replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 12);
  let code = `${base.base_code}-${slug}`.slice(0, 40);
  if (await txQueryOne(tx, 'SELECT id FROM mst_yarn WHERE company_id = ? AND yarn_code = ?', [cid, code])) code = `${code.slice(0, 33)}-${countId}`;
  const r = await txExecute(tx,
    `INSERT INTO mst_yarn (company_id, yarn_code, yarn_name, category_id, yarn_base_id, count_value, count_type, count_id,
                           composition_id, ply, yarn_type, hsn_code, base_uom, std_rate, is_active, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,0,1,?)`,
    [cid, code, `${base.base_name} ${cnt.count_value}${cnt.count_type && cnt.count_type !== 'Ne' ? ` ${cnt.count_type}` : ' Ne'}`.slice(0, 150),
     base.category_id ?? null, baseId, cnt.count_value, cnt.count_type || 'Ne', countId, base.composition_id ?? null,
     base.yarn_type || 'COMBED', base.hsn_code || null, base.base_uom, userId]);
  return Number(r.insertId);
}

async function writeLines(tx: any, bomId: number, lines: z.infer<typeof lineSchema>[], cid: number, userId: number) {
  for (const l of lines) {
    const isYarn = l.material_type === 'YARN';
    const isFabric = l.material_type === 'FABRIC';
    const yarnId = isYarn && l.yarn_base_id && l.yarn_count_id
      ? await resolveYarnVariant(tx, cid, userId, l.yarn_base_id, l.yarn_count_id)
      : l.yarn_id ?? null;
    const dyed = (isYarn || isFabric) && l.dye_type === 'DYED';
    await txExecute(tx,
      `INSERT INTO trx_bom_line
         (bom_id, material_type, yarn_id, fabric_id, trim_id, item_description,
          color_id, size_id, consumption_basis, applicability, consumption, additional_qty,
          uom_id, wastage_pct, specification, dia, gsm, yarn_base_id, yarn_count_id, dye_type, material_color_id, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [bomId, l.material_type, yarnId, l.fabric_id ?? null, l.trim_id ?? null,
       l.item_description ?? null, l.color_id ?? null, l.size_id ?? null,
       l.consumption_basis || 'PER_PIECE', l.applicability || 'ALL',
       l.consumption, l.additional_qty || 0, l.uom_id, l.wastage_pct ?? 0,
       l.specification ?? null,
       isFabric ? l.dia ?? null : null, isFabric ? l.gsm ?? null : null,
       isYarn ? l.yarn_base_id ?? null : null, isYarn ? l.yarn_count_id ?? null : null,
       isYarn || isFabric ? l.dye_type ?? null : null, dyed ? l.material_color_id ?? null : null,
       l.remarks ?? null]);
  }
}

bomRouter.post('/', requirePermission('BOM.CREATE'), ah(async (req, res) => {
  const body = bomSchema.parse(req.body);
  const created = await transaction(async (tx) => {
    const bomNo = body.bom_no || await nextDocNumber(tx, req.user!.companyId, 'BOM');
    const r = await txExecute(tx,
      `INSERT INTO trx_bom (company_id, style_id, so_id, bom_no, version, effective_date,
                            status_id, approval_state, remarks, is_active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, body.style_id, body.so_id ?? null, bomNo, body.version, body.effective_date ?? null,
       body.status_id ?? null, body.approval_state || 'DRAFT', body.remarks ?? null, body.is_active ?? 1, req.user!.id]);
    await writeLines(tx, r.insertId, body.lines, req.user!.companyId, req.user!.id);
    return txQueryOne(tx, `SELECT * FROM trx_bom WHERE id = ?`, [r.insertId]);
  });
  await audit(req, 'trx_bom', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

bomRouter.put('/:id', requirePermission('BOM.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('BOM not found');
  const body = bomSchema.partial().parse(req.body);

  const after = await transaction(async (tx) => {
    const { lines, ...head } = body;
    const cols = { ...head, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE trx_bom SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => (cols as any)[k]), id, req.user!.companyId]);
    }
    if (lines) {
      await txExecute(tx, `DELETE FROM trx_bom_line WHERE bom_id = ?`, [id]);
      await writeLines(tx, id, lines, req.user!.companyId, req.user!.id);
    }
    return txQueryOne(tx, `SELECT * FROM trx_bom WHERE id = ?`, [id]);
  });
  await audit(req, 'trx_bom', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

bomRouter.delete('/:id', requirePermission('BOM.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('BOM not found');
  await transaction((tx) => txExecute(tx, `UPDATE trx_bom SET is_active = 0, updated_by = ? WHERE id = ?`,
    [req.user!.id, id]));
  await audit(req, 'trx_bom', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

/** Explode a BOM for a given garment quantity — the costing/MRP preview. */
bomRouter.get('/:id/explode', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const qty = z.coerce.number().int().positive().default(1).parse(req.query.qty ?? 1);
  const bom = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');

  const lines = await withMaterialRates(req.user!.companyId, await query<any>(LINE_SELECT, [id]));
  const exploded = lines.map((l) => {
    // same rules as MRP / the BOM screen: basis (per piece / ÷ 12 per dozen / fixed qty for the order) + wastage + additional qty
    const perGarment = Number(l.consumption);
    const required = lineRequirement(l, qty).required;
    const withWastage = qty > 0 ? required / qty : 0;
    return {
      ...l,
      per_garment: perGarment,
      per_garment_with_wastage: Number(withWastage.toFixed(5)),
      total_required: Number(required.toFixed(5)),
      estimated_cost: Number((required * Number(l.std_rate ?? 0)).toFixed(4)),
    };
  });

  res.json({
    data: {
      bom, qty, lines: exploded,
      total_estimated_cost: Number(exploded.reduce((a, l) => a + l.estimated_cost, 0).toFixed(4)),
    },
  });
}));

/**
 * POST or GET /:id/calculate — Full material requirement calculation engine (Section 11, 26 of spec)
 * Base Qty = Applicable Order Qty * (Consumption / Basis Factor)
 * Wastage Qty = Base Qty * (Wastage % / 100)
 * Final Requirement = Base Qty + Additional Qty + Wastage Qty
 */
const handleCalculate = ah(async (req, res) => {
  const id = Number(req.params.id);
  const qty = Number(req.body?.order_qty || req.query?.qty || 1000);
  const bom = await queryOne<any>(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');

  const lines = await withMaterialRates(req.user!.companyId, await query<any>(LINE_SELECT, [id]));
  const calculated = lines.map((l) => {
    const cons = Number(l.consumption) || 0;
    const wastePct = Number(l.wastage_pct) || 0;
    const addl = Number(l.additional_qty) || 0;
    const basis = l.consumption_basis || 'PER_PIECE';

    let divisor = 1;
    if (basis === 'PER_DOZEN') divisor = 12;
    else if (basis === 'PER_SET') divisor = 1;
    else if (basis === 'FIXED_QTY') divisor = qty > 0 ? qty : 1;

    const baseQty = Number(((qty / divisor) * cons).toFixed(4));
    const wasteQty = Number((baseQty * (wastePct / 100)).toFixed(4));
    const finalReq = Number((baseQty + addl + wasteQty).toFixed(4));
    const rate = Number(l.std_rate) || 0;
    const estCost = Number((finalReq * rate).toFixed(2));

    return {
      ...l,
      order_qty: qty,
      consumption_basis: basis,
      base_qty: baseQty,
      additional_qty: addl,
      wastage_qty: wasteQty,
      final_requirement: finalReq,
      estimated_cost: estCost,
    };
  });

  res.json({
    success: true,
    data: {
      bom_id: id,
      bom_no: bom.bom_no,
      version: bom.version,
      order_qty: qty,
      lines: calculated,
      yarns: calculated.filter((l) => l.material_type === 'YARN'),
      fabrics: calculated.filter((l) => l.material_type === 'FABRIC'),
      trims: calculated.filter((l) => l.material_type === 'TRIM'),
      accessories: calculated.filter((l) => l.material_type === 'ACCESSORY'),
      packings: calculated.filter((l) => l.material_type === 'PACKING'),
      generals: calculated.filter((l) => l.material_type === 'GENERAL'),
      total_estimated_cost: Number(calculated.reduce((acc, l) => acc + l.estimated_cost, 0).toFixed(2)),
    },
  });
});

bomRouter.get('/:id/calculate', requirePermission('BOM.VIEW'), handleCalculate);
bomRouter.post('/:id/calculate', requirePermission('BOM.VIEW'), handleCalculate);

/** POST /:id/submit — Submit draft BOM for approval */
bomRouter.post('/:id/submit', requirePermission('BOM.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const bom = await queryOne<any>(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');

  await query(`UPDATE trx_bom SET approval_state = 'SUBMITTED', updated_by = ? WHERE id = ?`,
    [req.user!.id, id]);
  await audit(req, 'trx_bom', id, 'UPDATE', { approval_state: bom.approval_state }, { approval_state: 'SUBMITTED' });

  res.json({ success: true, message: 'BOM submitted for approval', data: { id, approval_state: 'SUBMITTED' } });
}));

/** POST /:id/approve — Approve BOM and supersede previous versions */
bomRouter.post('/:id/approve', requirePermission('BOM.APPROVE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cid = req.user!.companyId;
  const bom = await queryOne<any>(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, cid]);
  if (!bom) throw NotFound('BOM not found');

  await transaction(async (tx) => {
    // Supersede previous approved versions for the same style and SO
    await txExecute(tx, `
      UPDATE trx_bom
         SET approval_state = 'SUPERSEDED'
       WHERE company_id = ? AND style_id = ? AND id != ?
         AND (so_id <=> ?) AND approval_state = 'APPROVED'
    `, [cid, bom.style_id, id, bom.so_id ?? null]);

    // Approve current BOM
    await txExecute(tx, `
      UPDATE trx_bom
         SET approval_state = 'APPROVED', approved_by = ?, approved_at = NOW(), updated_by = ?
       WHERE id = ?
    `, [req.user!.id, req.user!.id, id]);
  });

  await audit(req, 'trx_bom', id, 'UPDATE', { approval_state: bom.approval_state }, { approval_state: 'APPROVED' });
  res.json({ success: true, message: 'BOM approved successfully', data: { id, approval_state: 'APPROVED' } });
}));

/** POST /:id/revision — Create revision (v+1) from approved BOM, preserving history */
bomRouter.post('/:id/revision', requirePermission('BOM.CREATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cid = req.user!.companyId;
  const bom = await queryOne<any>(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, cid]);
  if (!bom) throw NotFound('BOM not found');

  const newRevision = await transaction(async (tx) => {
    const nextVer = (Number(bom.version) || 1) + 1;
    const r = await txExecute(tx, `
      INSERT INTO trx_bom (company_id, style_id, so_id, bom_no, version, effective_date,
                            status_id, approval_state, remarks, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 'DRAFT', ?, 1, ?)
    `, [cid, bom.style_id, bom.so_id ?? null, bom.bom_no, nextVer, bom.status_id ?? null,
        `Revision v${nextVer} based on v${bom.version}`, req.user!.id]);

    const newId = r.insertId;
    const lines = await txQuery<any>(tx, `SELECT * FROM trx_bom_line WHERE bom_id = ?`, [id]);
    for (const l of lines) {
      await txExecute(tx, `
        INSERT INTO trx_bom_line (bom_id, material_type, yarn_id, fabric_id, trim_id, item_description,
                                  color_id, size_id, consumption_basis, applicability, consumption,
                                  additional_qty, uom_id, wastage_pct, specification, dia, gsm,
                                  yarn_base_id, yarn_count_id, dye_type, material_color_id, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [newId, l.material_type, l.yarn_id, l.fabric_id, l.trim_id, l.item_description,
          l.color_id, l.size_id, l.consumption_basis || 'PER_PIECE', l.applicability || 'ALL',
          l.consumption, l.additional_qty || 0, l.uom_id, l.wastage_pct || 0, l.specification ?? null,
          l.dia ?? null, l.gsm ?? null, l.yarn_base_id ?? null, l.yarn_count_id ?? null, l.dye_type ?? null,
          l.material_color_id ?? null, l.remarks]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_bom WHERE id = ?`, [newId]);
  });

  await audit(req, 'trx_bom', (newRevision as any).id, 'INSERT', { source_bom_id: id }, newRevision);
  res.status(201).json({
    success: true,
    message: `Created revision v${(newRevision as any).version}`,
    data: newRevision,
  });
}));

/** GET /latest-cad/:styleId — Check for approved CAD Auto-Consumption for style */
bomRouter.get('/latest-cad/:styleId', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const styleId = Number(req.params.styleId);

  const cadReq = await queryOne<any>(`
    SELECT cmr.id AS cmr_id, cmr.total_fabric_kg, cmr.total_yarn_kg, cmr.created_at AS approved_at,
           cr.id AS cad_req_id, cr.req_no, cr.order_qty, cr.marker_efficiency, cr.cad_version
      FROM trx_cad_material_requirement cmr
      JOIN trx_cad_requirement cr ON cr.id = cmr.cad_req_id
     WHERE cmr.company_id = ? AND cmr.style_id = ? AND cmr.status = 'APPROVED'
     ORDER BY cmr.id DESC LIMIT 1
  `, [cid, styleId]);

  if (!cadReq) {
    return res.json({ success: true, data: null });
  }

  const orderQty = Number(cadReq.order_qty) || 1000;
  const totalFabric = Number(cadReq.total_fabric_kg) || 0;
  const totalYarn = Number(cadReq.total_yarn_kg) || 0;

  res.json({
    success: true,
    data: {
      ...cadReq,
      fabric_consumption_per_pc: totalFabric > 0 ? Number((totalFabric / orderQty).toFixed(5)) : 0.82,
      yarn_consumption_per_pc: totalYarn > 0 ? Number((totalYarn / orderQty).toFixed(5)) : 0.86,
    },
  });
}));

/** POST /:id/sync-cad — Sync CAD auto-consumption into BOM Yarn & Fabric lines */
bomRouter.post('/:id/sync-cad', requirePermission('BOM.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cid = req.user!.companyId;

  const bom = await queryOne<any>(`
    SELECT b.* FROM trx_bom b WHERE b.id = ? AND b.company_id = ?
  `, [id, cid]);
  if (!bom) throw NotFound('BOM not found');

  // Look for approved CAD material requirement
  const cadReq = await queryOne<any>(`
    SELECT cmr.*, cr.req_no, cr.order_qty, cr.marker_efficiency, cr.data_json
      FROM trx_cad_material_requirement cmr
      JOIN trx_cad_requirement cr ON cr.id = cmr.cad_req_id
     WHERE cmr.company_id = ? AND cmr.style_id = ?
     ORDER BY cmr.id DESC LIMIT 1
  `, [cid, bom.style_id]);

  if (!cadReq) {
    throw BadRequest('No approved CAD Auto-Consumption found for this Style. Please create & approve a CAD requirement first.');
  }

  const orderQty = Number(cadReq.order_qty) || 1000;
  const totalFabricKg = Number(cadReq.total_fabric_kg) || 0;
  const totalYarnKg = Number(cadReq.total_yarn_kg) || 0;

  const fabricConsPerGmt = totalFabricKg > 0 ? Number((totalFabricKg / orderQty).toFixed(5)) : 0.82;
  const yarnConsPerGmt = totalYarnKg > 0 ? Number((totalYarnKg / orderQty).toFixed(5)) : Number((fabricConsPerGmt * 1.05).toFixed(5));

  const defaultFabric = await queryOne<any>(`SELECT id, base_uom FROM mst_fabric WHERE company_id = ? AND is_active = 1 LIMIT 1`, [cid]);
  const defaultYarn = await queryOne<any>(`SELECT id, base_uom FROM mst_yarn WHERE company_id = ? AND is_active = 1 LIMIT 1`, [cid]);
  const kgUom = await queryOne<any>(`SELECT id FROM cfg_uom WHERE (code = 'KG' OR code = 'KGS') LIMIT 1`);
  const uomId = kgUom?.id || defaultFabric?.base_uom || defaultYarn?.base_uom || 1;

  await transaction(async (tx) => {
    const existingFabric = await txQueryOne<any>(tx, `
      SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'FABRIC' LIMIT 1
    `, [id]);

    if (existingFabric) {
      await txExecute(tx, `
        UPDATE trx_bom_line
           SET consumption = ?, wastage_pct = 5.0, remarks = CONCAT('CAD Auto-Synced: ', ?)
         WHERE id = ?
      `, [fabricConsPerGmt, cadReq.req_no || 'CAD V01', existingFabric.id]);
    } else if (defaultFabric) {
      await txExecute(tx, `
        INSERT INTO trx_bom_line (bom_id, material_type, fabric_id, consumption, uom_id, wastage_pct, remarks)
        VALUES (?, 'FABRIC', ?, ?, ?, 5.0, ?)
      `, [id, defaultFabric.id, fabricConsPerGmt, uomId, `CAD Auto-Synced (${cadReq.req_no || 'CAD'})`]);
    }

    const existingYarn = await txQueryOne<any>(tx, `
      SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'YARN' LIMIT 1
    `, [id]);

    if (existingYarn) {
      await txExecute(tx, `
        UPDATE trx_bom_line
           SET consumption = ?, wastage_pct = 3.0, remarks = CONCAT('CAD Auto-Synced: ', ?)
         WHERE id = ?
      `, [yarnConsPerGmt, cadReq.req_no || 'CAD V01', existingYarn.id]);
    } else if (defaultYarn) {
      await txExecute(tx, `
        INSERT INTO trx_bom_line (bom_id, material_type, yarn_id, consumption, uom_id, wastage_pct, remarks)
        VALUES (?, 'YARN', ?, ?, ?, 3.0, ?)
      `, [id, defaultYarn.id, yarnConsPerGmt, uomId, `CAD Auto-Synced (${cadReq.req_no || 'CAD'})`]);
    }
  });

  const updatedLines = await withMaterialRates(cid, await query<any>(LINE_SELECT, [id]));
  res.json({
    success: true,
    message: `Successfully synced CAD auto-consumption from ${cadReq.req_no || 'CAD'} (Fabric: ${fabricConsPerGmt} KG/pc, Yarn: ${yarnConsPerGmt} KG/pc)`,
    data: { ...bom, lines: updatedLines },
  });
}));

