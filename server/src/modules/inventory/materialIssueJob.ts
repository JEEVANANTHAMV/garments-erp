import { query, queryOne } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { jobBomRequirement } from '../bom/bom.routes.js';
import { jobAllowances } from '../../core/purchaseExcess.js';
import { yarnJobLots } from '../stock/jobStock.routes.js';

/**
 * Material Issue against a work order (client clip 04-Nov-2026): "when we pick yarn it shows ALL yarns — show only
 * what that job has / requires". Per item of the chosen type, for the work order's job (sales order) + style:
 *
 *   required  = the job's BOM requirement (jobBomRequirement — same figures as MRP / BOM print / PO excess)
 *   purchased = approved PO qty of the job for the item (fabric / yarn / general POs + trim POs, in the BOM UOM) —
 *               it already holds the purchase excess the job was allowed to buy (client 05-Nov-2026: "issue what we
 *               purchased — purchase + purchase-excess qty — distribute based on that")
 *   received  = accepted GRN qty against those POs for the job, less posted purchase returns
 *   allowed   = basis PURCHASE (the job has a PO for the item): min(received, purchased) — nothing is issued before it
 *               arrives, never more than was bought for the job;
 *               basis REQUIREMENT (no PO — e.g. issued from general stock): required × (1 + excess %) + excess qty.
 *               PURCHASE_EXCESS_CONTROL BLOCK / WARN / OFF applies to issued + qty > allowed
 *   issued    = material issues already posted to work orders of the same job + style (same UOM as the BOM)
 *   job / general / other-job stock in the From store — from the job-wise stock (yarn lots, fabric rolls, trim stock);
 *   store     = the stock-ledger balance of the store (what the issue actually takes out)
 *
 * What a job may issue from the store (same rules as elsewhere): yarn and trims — its own + general stock (DCs,
 * packing); fabric — its own rolls only, a general roll is transferred to the job first (lay engine). Store stock that
 * is not held in lots / rolls (opening, adjustments) counts as general. Never more than the store balance.
 */
export type IssueMaterial = 'YARN' | 'FABRIC' | 'TRIM';
const TRIM_TYPES = ['TRIM', 'ACCESSORY', 'PACKING'];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const col = (m: IssueMaterial) => (m === 'YARN' ? 'yarn_id' : m === 'FABRIC' ? 'fabric_id' : 'trim_id');

export interface JobIssueItem {
  item_id: number; item_name: string; item_code: string | null; uom_id: number | null; uom_code: string | null;
  on_requirement: boolean; required: number | null; allowed: number | null; issued: number; balance_to_issue: number | null;
  /** PURCHASE = the job bought this item (allowed from purchased / received); REQUIREMENT = BOM + excess allowance */
  basis: 'PURCHASE' | 'REQUIREMENT' | null; purchased: number | null; received: number | null; po_nos: string | null;
  job_stock: number; general_stock: number; other_job_stock: number; store_stock: number; available_for_job: number;
}

export async function workOrderJob(cid: number, prodOrderId: number) {
  const wo = await queryOne<any>(
    `SELECT p.id, p.po_prod_no, p.so_id, p.style_id, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, st.style_code
       FROM trx_production_order p LEFT JOIN trx_sales_order so ON so.id = p.so_id LEFT JOIN mst_style st ON st.id = p.style_id
      WHERE p.id = ? AND p.company_id = ?`, [prodOrderId, cid]);
  if (!wo) throw NotFound('Work order not found');
  return wo;
}

/** Store-ledger balance per item of one material in one store. */
async function storeBalances(cid: number, warehouseId: number, m: IssueMaterial) {
  const rows = await query<any>(
    `SELECT ${col(m)} item_id, SUM(qty_in) - SUM(qty_out) bal FROM trx_stock_ledger
      WHERE company_id = ? AND warehouse_id = ? AND material_type = ? AND ${col(m)} IS NOT NULL GROUP BY ${col(m)}`, [cid, warehouseId, m]);
  return new Map(rows.map((r) => [Number(r.item_id), n(r.bal)]));
}

/** Job-wise holdings per item in one store: { job, general, other }. */
async function jobHoldings(cid: number, warehouseId: number, m: IssueMaterial, soId: number | null) {
  const out = new Map<number, { job: number; general: number; other: number }>();
  const add = (id: number, holder: number | null, qty: number) => {
    if (!id || qty <= 0) return;
    const h = out.get(id) ?? { job: 0, general: 0, other: 0 };
    if (!holder) h.general += qty; else if (soId && holder === soId) h.job += qty; else h.other += qty;
    out.set(id, h);
  };
  if (m === 'YARN') {
    for (const l of await yarnJobLots(cid, { warehouse_id: warehouseId })) add(Number(l.yarn_id), l.holder_so_id ? Number(l.holder_so_id) : null, n(l.available_kg));
  } else if (m === 'FABRIC') {
    const rows = await query<any>(
      `SELECT fabric_id, so_id, SUM(weight_kg - COALESCE(issued_kg, 0)) bal FROM trx_fabric_roll
        WHERE company_id = ? AND warehouse_id = ? AND qc_status = 'ACCEPTED' AND stock_status <> 'CLOSED' AND weight_kg - COALESCE(issued_kg, 0) > 0.0005
        GROUP BY fabric_id, so_id`, [cid, warehouseId]);
    for (const r of rows) add(Number(r.fabric_id), r.so_id ? Number(r.so_id) : null, n(r.bal));
  } else {
    const rows = await query<any>(
      `SELECT trim_id, so_key, SUM(stock_qty - allocated_qty) bal FROM trx_trim_stock
        WHERE company_id = ? AND warehouse_id = ? AND stock_qty - allocated_qty > 0.0005 GROUP BY trim_id, so_key`, [cid, warehouseId]);
    for (const r of rows) add(Number(r.trim_id), Number(r.so_key) || null, n(r.bal));
  }
  return out;
}

/** Requirement (BOM) per item for the job + style; empty when the job has no BOM yet. */
async function jobRequirement(cid: number, soId: number | null, styleId: number | null, m: IssueMaterial) {
  const req = new Map<number, { required: number; uom_id: number | null; uom_code: string | null; name: string }>();
  if (!soId) return req;
  let r: any;
  try { r = await jobBomRequirement(cid, { so_id: soId, ...(styleId ? { style_id: styleId } : {}) }); } catch { return req; }
  for (const l of r?.lines ?? []) {
    const ok = m === 'TRIM' ? TRIM_TYPES.includes(l.material_type) : l.material_type === m;
    const id = Number(l[col(m)]);
    if (!ok || !id) continue;
    const cur = req.get(id);
    if (cur) cur.required += n(l.final_requirement);
    else req.set(id, { required: n(l.final_requirement), uom_id: l.uom_id ? Number(l.uom_id) : null, uom_code: l.uom_code ?? null, name: l.material_name });
  }
  return req;
}

/** Already issued to the job + style (work orders of the same sales order and style), per item and UOM. */
async function issuedToJob(cid: number, soId: number | null, styleId: number | null, m: IssueMaterial) {
  if (!soId) return [] as { item_id: number; uom_id: number; qty: number }[];
  const rows = await query<any>(
    `SELECT l.${col(m)} item_id, l.uom_id, SUM(l.issued_qty) qty
       FROM trx_material_issue_line l JOIN trx_material_issue mi ON mi.id = l.issue_id
       JOIN trx_production_order p ON p.id = mi.prod_order_id
      WHERE mi.company_id = ? AND p.so_id = ? AND (p.style_id <=> ?) AND l.material_type = ? AND l.${col(m)} IS NOT NULL
      GROUP BY l.${col(m)}, l.uom_id`, [cid, soId, styleId, m]);
  return rows.map((r) => ({ item_id: Number(r.item_id), uom_id: Number(r.uom_id), qty: n(r.qty) }));
}

/**
 * Bought and received for the job + style per item (in each line's UOM): approved PO lines (POs APPROVED / CLOSED,
 * trim POs APPROVED / PARTIAL / CLOSED) and the accepted GRN qty against POs of the job, less posted purchase returns.
 * A PO / GRN line without a style counts for every style of the job.
 */
async function jobPurchased(cid: number, soId: number | null, styleId: number | null, jobNo: string | null, m: IssueMaterial) {
  const out = new Map<number, { uom_id: number | null; purchased: number; received: number; pos: Set<string> }[]>();
  if (!soId) return out;
  const add = (id: number, uom: number | null, k: 'purchased' | 'received', qty: number, po?: string | null) => {
    if (!id) return;
    const list = out.get(id) ?? [];
    let e = list.find((x) => x.uom_id === uom);
    if (!e) { e = { uom_id: uom, purchased: 0, received: 0, pos: new Set() }; list.push(e); }
    e[k] += qty;
    if (po) for (const x of String(po).split(',')) if (x) e.pos.add(x);
    out.set(id, list);
  };
  const c = col(m);
  const styleOk = (expr: string) => (styleId ? `(${expr} IS NULL OR ${expr} = ${Number(styleId)})` : '1=1');
  const [po, grn, ret] = await Promise.all([
    query<any>(
      `SELECT pl.${c} item_id, pl.uom_id, SUM(pl.qty) qty, GROUP_CONCAT(DISTINCT p.po_no) pos
         FROM trx_purchase_order_line pl JOIN trx_purchase_order p ON p.id = pl.po_id
        WHERE p.company_id = ? AND COALESCE(pl.so_id, p.so_id) = ? AND ${styleOk('COALESCE(pl.style_id, p.style_id)')}
          AND COALESCE(p.is_deleted, 0) = 0 AND p.approval_state IN ('APPROVED', 'CLOSED')
          AND pl.material_type = ? AND pl.${c} IS NOT NULL
        GROUP BY pl.${c}, pl.uom_id`, [cid, soId, m]),
    query<any>(
      `SELECT gl.${c} item_id, gl.uom_id, SUM(COALESCE(gl.accepted_qty, gl.received_qty - COALESCE(gl.rejected_qty, 0), 0)) qty
         FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
         LEFT JOIN trx_purchase_order_line pl ON pl.id = gl.po_line_id
         JOIN trx_purchase_order p ON p.id = COALESCE(pl.po_id, gl.po_id, g.po_id)
        WHERE g.company_id = ? AND COALESCE(gl.so_id, pl.so_id, p.so_id) = ? AND ${styleOk('COALESCE(gl.style_id, pl.style_id, p.style_id)')}
          AND gl.material_type = ? AND gl.${c} IS NOT NULL
        GROUP BY gl.${c}, gl.uom_id`, [cid, soId, m]),
    m === 'TRIM' ? Promise.resolve([] as any[]) : query<any>(
      `SELECT gl.${c} item_id, gl.uom_id, SUM(rl.return_qty) qty
         FROM trx_purchase_return_line rl JOIN trx_purchase_return r ON r.id = rl.return_id
         JOIN trx_grn_line gl ON gl.id = rl.grn_line_id JOIN trx_grn g ON g.id = gl.grn_id
         LEFT JOIN trx_purchase_order_line pl ON pl.id = gl.po_line_id
         JOIN trx_purchase_order p ON p.id = COALESCE(pl.po_id, gl.po_id, g.po_id)
        WHERE r.company_id = ? AND COALESCE(r.stock_posted, 0) = 1 AND COALESCE(r.status, '') NOT IN ('CANCELLED', 'REJECTED', 'DRAFT')
          AND COALESCE(gl.so_id, pl.so_id, p.so_id) = ? AND ${styleOk('COALESCE(gl.style_id, pl.style_id, p.style_id)')}
          AND gl.material_type = ? AND gl.${c} IS NOT NULL
        GROUP BY gl.${c}, gl.uom_id`, [cid, soId, m]),
  ]);
  for (const r of po) add(Number(r.item_id), r.uom_id ? Number(r.uom_id) : null, 'purchased', n(r.qty), r.pos);
  for (const r of grn) add(Number(r.item_id), r.uom_id ? Number(r.uom_id) : null, 'received', n(r.qty));
  for (const r of ret) add(Number(r.item_id), r.uom_id ? Number(r.uom_id) : null, 'received', -n(r.qty));
  if (m === 'TRIM') {
    const io = jobNo ?? '';
    const [tpo, tgrn] = await Promise.all([
      query<any>(
        `SELECT tl.trim_id item_id, tl.uom_id, SUM(tl.order_qty) qty, GROUP_CONCAT(DISTINCT t.po_no) pos
           FROM trx_trim_po_line tl JOIN trx_trim_po t ON t.id = tl.po_id
          WHERE t.company_id = ? AND t.status IN ('APPROVED', 'PARTIAL', 'CLOSED') AND tl.trim_id IS NOT NULL
            AND (tl.so_id = ? OR (tl.so_id IS NULL AND t.io_no = ?)) AND ${styleOk('tl.style_id')}
          GROUP BY tl.trim_id, tl.uom_id`, [cid, soId, io]).catch(() => [] as any[]),
      query<any>(
        `SELECT gl.trim_id item_id, gl.uom_id, SUM(COALESCE(gl.accepted_qty, gl.received_qty - COALESCE(gl.rejected_qty, 0), 0)) qty
           FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id
           LEFT JOIN trx_trim_po_line pl ON pl.id = gl.po_line_id
           JOIN trx_trim_po t ON t.id = COALESCE(pl.po_id, gl.po_id, g.po_id)
          WHERE g.company_id = ? AND g.status = 'POSTED' AND gl.trim_id IS NOT NULL
            AND (COALESCE(gl.so_id, pl.so_id) = ? OR (COALESCE(gl.so_id, pl.so_id) IS NULL AND COALESCE(t.io_no, g.io_no) = ?))
            AND ${styleOk('COALESCE(gl.style_id, pl.style_id)')}
          GROUP BY gl.trim_id, gl.uom_id`, [cid, soId, io]).catch(() => [] as any[]),
    ]);
    for (const r of tpo) add(Number(r.item_id), r.uom_id ? Number(r.uom_id) : null, 'purchased', n(r.qty), r.pos);
    for (const r of tgrn) add(Number(r.item_id), r.uom_id ? Number(r.uom_id) : null, 'received', n(r.qty));
  }
  return out;
}

export async function jobIssueItems(cid: number, q: { prod_order_id: number; material_type: IssueMaterial; warehouse_id?: number | null; all?: boolean }) {
  const wo = await workOrderJob(cid, q.prod_order_id);
  const m = q.material_type;
  const soId = wo.so_id ? Number(wo.so_id) : null;
  const styleId = wo.style_id ? Number(wo.style_id) : null;
  const [reqMap, issued, store, hold, allow, bought] = await Promise.all([
    jobRequirement(cid, soId, styleId, m),
    issuedToJob(cid, soId, styleId, m),
    q.warehouse_id ? storeBalances(cid, q.warehouse_id, m) : Promise.resolve(new Map<number, number>()),
    q.warehouse_id ? jobHoldings(cid, q.warehouse_id, m, soId) : Promise.resolve(new Map<number, { job: number; general: number; other: number }>()),
    soId ? jobAllowances(cid, soId) : Promise.resolve(null),
    jobPurchased(cid, soId, styleId, wo.job_no ? String(wo.job_no) : null, m),
  ]);
  const al = allow?.allowances[m];

  // which items: the requirement; else what the job holds; "show all" adds everything in stock in the store
  const ids = new Set<number>(reqMap.keys());
  const source: 'REQUIREMENT' | 'JOB_STOCK' | 'ALL' = q.all ? 'ALL' : reqMap.size ? 'REQUIREMENT' : 'JOB_STOCK';
  if (source !== 'REQUIREMENT') for (const [id, h] of hold) if (h.job > 0.0005) ids.add(id);
  // bought for the job (PO) though not on the BOM — it was purchased for this job, so it is listed and issuable
  for (const [id, list] of bought) if (list.some((x) => x.purchased > 0.0005)) ids.add(id);
  if (q.all) for (const [id, bal] of store) if (bal > 0.0005) ids.add(id);
  if (!ids.size) return { work_order: wo, source, control: allow?.control ?? 'OFF', allowance: al ?? null, items: [] as JobIssueItem[] };

  const tbl = m === 'YARN' ? 'mst_yarn' : m === 'FABRIC' ? 'mst_fabric' : 'mst_trim';
  const nm = m === 'YARN' ? 'yarn' : m === 'FABRIC' ? 'fabric' : 'trim';
  const masters = await query<any>(
    `SELECT i.id, i.${nm}_name name, i.${nm}_code code, i.base_uom, u.code uom_code FROM ${tbl} i LEFT JOIN cfg_uom u ON u.id = i.base_uom
      WHERE i.company_id = ? AND i.id IN (?)`, [cid, [...ids]]);
  const items: JobIssueItem[] = masters.map((x) => {
    const id = Number(x.id);
    const rq = reqMap.get(id);
    const uomId = rq?.uom_id ?? (x.base_uom ? Number(x.base_uom) : null);
    const iss = issued.filter((i) => i.item_id === id && (!uomId || i.uom_id === uomId)).reduce((a, i) => a + i.qty, 0);
    // bought for the job in the issue UOM (the BOM's, else the item's base UOM)
    const b = (bought.get(id) ?? []).filter((x) => !uomId || !x.uom_id || x.uom_id === uomId);
    const purchased = b.reduce((a, x) => a + x.purchased, 0);
    const received = b.reduce((a, x) => a + x.received, 0);
    const basis: JobIssueItem['basis'] = purchased > 0.0005 ? 'PURCHASE' : rq ? 'REQUIREMENT' : null;
    const allowed = basis === 'PURCHASE' ? r3(Math.max(0, Math.min(received, purchased)))
      : rq ? r3(rq.required * (1 + (al?.pct ?? 0) / 100) + (al?.qty ?? 0)) : null;
    const h = hold.get(id) ?? { job: 0, general: 0, other: 0 };
    const st = store.get(id) ?? 0;
    const unattributed = Math.max(0, st - (h.job + h.general + h.other));   // store stock not in lots / rolls
    const forJob = m === 'FABRIC' ? h.job + unattributed : h.job + h.general + unattributed;
    return {
      item_id: id, item_name: rq?.name || x.name, item_code: x.code ?? null, uom_id: uomId, uom_code: rq?.uom_code ?? x.uom_code ?? null,
      on_requirement: !!rq, required: rq ? r3(rq.required) : null, allowed, issued: r3(iss),
      basis, purchased: basis === 'PURCHASE' ? r3(purchased) : null, received: basis === 'PURCHASE' ? r3(received) : null,
      po_nos: basis === 'PURCHASE' ? [...new Set(b.flatMap((x) => [...x.pos]))].join(', ') || null : null,
      // purchase basis: what is left of the bought-and-received qty; requirement basis: requirement − issued (as before)
      balance_to_issue: basis === 'PURCHASE' ? r3(Math.max(0, (allowed ?? 0) - iss)) : rq ? r3(Math.max(0, rq.required - iss)) : null,
      job_stock: r3(h.job), general_stock: r3(h.general + unattributed), other_job_stock: r3(h.other), store_stock: r3(st),
      available_for_job: r3(Math.max(0, Math.min(st, forJob))),
    };
  }).sort((a, b) => Number(b.on_requirement) - Number(a.on_requirement) || Number(b.basis === 'PURCHASE') - Number(a.basis === 'PURCHASE') || a.item_name.localeCompare(b.item_name));
  return { work_order: wo, source, control: allow?.control ?? 'OFF', allowance: al ?? null, items };
}

/**
 * Server-side checks of a material issue against its work order (the dropdown is only a help):
 *  - an item not on the job's requirement needs `allow_off_requirement` + a remark (the "Show all items" path);
 *  - qty ≤ what the job may take from the store (own + general stock; fabric: own rolls) — stock of other jobs is
 *    transferred first;
 *  - issued + qty ≤ allowed: bought for the job → min(received, purchased incl. excess); no PO for the item →
 *    requirement + purchase excess allowance. BLOCK → refused, WARN → notice.
 * Returns the warnings to show.
 */
export async function checkIssueAgainstJob(cid: number, body: {
  warehouse_id: number; prod_order_id?: number | null; remarks?: string | null; allow_off_requirement?: boolean;
  lines: { material_type: IssueMaterial; yarn_id?: number | null; fabric_id?: number | null; trim_id?: number | null; issued_qty: number; uom_id: number }[];
}) {
  const warnings: string[] = [];
  if (!body.prod_order_id) return warnings;
  const byType = new Map<IssueMaterial, Awaited<ReturnType<typeof jobIssueItems>>>();
  const used = new Map<string, number>();
  for (const l of body.lines) {
    const m = l.material_type;
    if (!byType.has(m)) byType.set(m, await jobIssueItems(cid, { prod_order_id: body.prod_order_id, material_type: m, warehouse_id: body.warehouse_id, all: true }));
    const info = byType.get(m)!;
    const id = Number(l[col(m)]);
    const it = info.items.find((x) => x.item_id === id);
    const name = it?.item_name ?? `${m.toLowerCase()} #${id}`;
    const job = info.work_order.job_no ? `job ${info.work_order.job_no}` : `work order ${info.work_order.po_prod_no}`;
    const k = `${m}:${id}`;
    const qty = (used.get(k) ?? 0) + n(l.issued_qty);
    used.set(k, qty);
    if (!it?.on_requirement && it?.basis !== 'PURCHASE') {
      const hasReq = info.items.some((x) => x.on_requirement);
      if (hasReq && !body.allow_off_requirement) throw BadRequest(`${name} is not on the requirement of ${job} — tick "Show all items" and give the reason in remarks to issue it`);
      if (hasReq && !(body.remarks ?? '').trim()) throw BadRequest(`${name} is not on the requirement of ${job} — give the reason in remarks`);
      if (hasReq) warnings.push(`${name} issued outside the requirement of ${job}`);
    }
    if (it && qty > it.available_for_job + 1e-6) {
      throw BadRequest(`${name}: ${job} can take only ${it.available_for_job} ${it.uom_code ?? ''} from this store (own ${it.job_stock}${m === 'FABRIC' ? '' : ` + general ${it.general_stock}`})`
        + (it.other_job_stock > 0 ? ` — ${it.other_job_stock} belongs to other jobs, transfer it to this job first` : ''));
    }
    if (it && (it.on_requirement || it.basis === 'PURCHASE') && it.allowed != null && (!it.uom_id || it.uom_id === Number(l.uom_id)) && info.control !== 'OFF') {
      const after = r3(it.issued + qty);
      if (after > it.allowed + 1e-6) {
        const u = it.uom_code ?? '';
        const msg = it.basis === 'PURCHASE'
          ? `${name}: issue would total ${after} ${u} — ${job} bought ${it.purchased} ${u} (incl. purchase excess, ${it.po_nos ?? 'POs'}) and received ${it.received} ${u}, already issued ${it.issued}; it can issue at most ${it.allowed} (purchased and received)`
          : `${name}: issue would total ${after} ${u} against the requirement ${it.required} (allowed ${it.allowed} incl. excess) of ${job}`;
        if (info.control === 'BLOCK') throw BadRequest(`${msg} — over-issue is blocked`);
        warnings.push(msg);
      }
    }
  }
  return warnings;
}
