import { Router, type Request } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';
import { grnBillRows } from '../inventory/gateBill.routes.js';

/**
 * Client report set, part B (client tracker 14-Oct-2026 — "Business Process(New)" rows 121-158):
 * purchase, stores, gate, bills and users. Read-only, company-scoped. Mounted at /api/client-reports,
 * every route lives under /b/… so it never collides with part A.
 *
 * Every endpoint returns { data: Row[], meta: { footnotes: string[] } } (clientReportKit contract).
 * Every row carries `*_link` fields used by the web page for drill-down to the source document.
 */
export const clientReportsBRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optId = z.coerce.number().int().positive().optional();
const cidOf = (req: Request) => req.user!.companyId;
const dstr = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const daysBetween = (from: unknown, to?: unknown) => {
  const a = dstr(from); if (!a) return null;
  const b = dstr(to) ?? dstr(new Date())!;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
};
const inRange = (d: unknown, from?: string, to?: string) => {
  const s = dstr(d);
  if (!s) return !from && !to;
  return (!from || s >= from) && (!to || s <= to);
};
const parseIds = (v: unknown): number[] => {
  if (!v) return [];
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter(Boolean) : []; } catch { return []; }
};
const STATUS = z.enum(['all', 'done', 'pending']).default('all');
/** a query that tolerates a missing optional table / column (older databases) */
const safe = <T = any>(sql: string, params: unknown[]) => query<T>(sql, params).catch(() => [] as T[]);
const tableExists = async (t: string) =>
  !!(await query<any>(`SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, [t]))[0];

const grnLink = (mat: string, id: number) =>
  mat.includes('YARN') ? `/procurement/yarn/grn/${id}` : mat.includes('FABRIC') ? `/procurement/fabric/grn/${id}` : '/procurement/grns';
const poLink = (mat: string, id: number | null) =>
  !id ? null : mat.includes('YARN') ? `/procurement/yarn/orders/${id}` : mat.includes('FABRIC') ? `/procurement/fabric/orders/${id}` : '/procurement/purchase-orders';

// =====================================================================================
// 1. GR / IR — goods received, invoice (bill) not accounted
// =====================================================================================
interface GrirRow {
  source: string; grn_type: string; grn_id: number; grn_no: string; grn_date: string | null; unit: string | null; location: string | null;
  party_dc_no: string | null; party_dc_date: string | null; po_no: string | null; po_id: number | null; party: string | null; party_id: number | null;
  item: string; uom: string | null; in_qty: number; in_amt: number; in_amt_gst: number; bill_qty: number; bill_amt: number; bal_qty: number; bal_amt: number;
  age: number | null; stores_passed_date: string | null; gate_entry_no: string | null; gate_inward_id: number | null; bill_no: string | null; bill_date: string | null;
  prepared_by: string | null; status: 'DONE' | 'PENDING'; grn_link: string; po_link: string | null; gate_link: string | null; bill_link: string | null;
}

async function grirRows(cid: number): Promise<GrirRow[]> {
  const out: GrirRow[] = [];
  // ---- yarn / fabric purchase GRN lines (same population as /procurement/grn-bill-status: GRNs raised against a PO) ----
  const lines = await query<any>(
    `SELECT gl.id line_id, g.id grn_id, g.grn_no, g.grn_date, g.created_at, gl.material_type, g.receipt_type,
            COALESCE(gl.po_id, g.po_id) po_id, po.po_no, g.supplier_id, p.party_name, w.warehouse_name, un.unit_name,
            COALESCE(NULLIF(g.supplier_dc_no, ''), gi.supplier_dc_no) dc_no, gi.supplier_dc_date dc_date, gi.entry_no, g.gate_inward_id,
            COALESCE(y.yarn_name, f.fabric_name, t.trim_name, CONCAT(gl.material_type, ' ', COALESCE(gl.yarn_count_str, ''))) item,
            gl.color_name, u.code uom, gl.accepted_qty, gl.rate,
            COALESCE(NULLIF(gl.taxable_amount, 0), gl.accepted_qty * gl.rate) amt, COALESCE(NULLIF(gl.total_amount, 0), gl.accepted_qty * gl.rate) amt_gst,
            g.qc_status, us.full_name prepared_by
       FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id)
       LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
       LEFT JOIN trx_gate_inward gi ON gi.id = g.gate_inward_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_fabric f ON f.id = gl.fabric_id
       LEFT JOIN mst_trim t ON t.id = gl.trim_id LEFT JOIN cfg_uom u ON u.id = gl.uom_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND (g.po_id IS NOT NULL OR gl.po_id IS NOT NULL OR gl.po_line_id IS NOT NULL)
      ORDER BY g.grn_date, g.id, gl.id`, [cid]);
  const bills = await query<any>(
    `SELECT id, bill_no, bill_date, supplier_inv_no, supplier_inv_date, grn_id, grn_ids, trim_grn_ids FROM trx_supplier_bill WHERE company_id = ? AND status <> 'CANCELLED'`, [cid]);
  const blines = bills.length ? await query<any>('SELECT bill_id, grn_id, grn_line_id, bill_qty, amount FROM trx_supplier_bill_line WHERE bill_id IN (?)', [bills.map((b) => b.id)]) : [];
  const billById = new Map(bills.map((b) => [Number(b.id), b]));
  const lineOfGrn = new Map<number, number>(lines.map((l) => [Number(l.line_id), Number(l.grn_id)]));
  const byLine = new Map<number, any[]>();
  const grnHasLineBill = new Set<string>();
  for (const bl of blines) {
    if (bl.grn_line_id) {
      const k = Number(bl.grn_line_id);
      byLine.set(k, [...(byLine.get(k) ?? []), bl]);
      grnHasLineBill.add(`${bl.bill_id}:${lineOfGrn.get(k)}`);
    }
  }
  const billLabel = (b: any) => (b.supplier_inv_no ? `${b.bill_no} / ${b.supplier_inv_no}` : b.bill_no);
  for (const l of lines) {
    const gid = Number(l.grn_id); const inQty = n(l.accepted_qty); const inAmt = n(l.amt);
    const hits = byLine.get(Number(l.line_id)) ?? [];
    let billQty = hits.reduce((a, b) => a + n(b.bill_qty), 0);
    let billAmt = hits.reduce((a, b) => a + n(b.amount), 0);
    const billIds = new Set<number>(hits.map((h) => Number(h.bill_id)));
    // a bill linked to the GRN at header level (no line for this GRN) covers the whole GRN
    for (const b of bills) {
      const linked = Number(b.grn_id) === gid || parseIds(b.grn_ids).includes(gid)
        || blines.some((x) => Number(x.bill_id) === Number(b.id) && Number(x.grn_id) === gid && !x.grn_line_id);
      if (linked && !grnHasLineBill.has(`${b.id}:${gid}`)) { billQty = inQty; billAmt = inAmt; billIds.add(Number(b.id)); }
    }
    const bl = [...billIds].map((i) => billById.get(i)).filter(Boolean);
    const balQty = r3(Math.max(0, inQty - billQty)); const balAmt = r2(Math.max(0, inAmt - billAmt));
    const mat = String(l.material_type ?? '');
    out.push({ source: 'PURCHASE', grn_type: `${mat || 'PURCHASE'} GRN${l.receipt_type ? ` (${l.receipt_type})` : ''}`, grn_id: gid, grn_no: l.grn_no, grn_date: dstr(l.grn_date),
      unit: l.unit_name, location: l.warehouse_name, party_dc_no: l.dc_no, party_dc_date: dstr(l.dc_date), po_no: l.po_no, po_id: l.po_id, party: l.party_name, party_id: l.supplier_id,
      item: [l.item, l.color_name].filter(Boolean).join(' · '), uom: l.uom, in_qty: r3(inQty), in_amt: r2(inAmt), in_amt_gst: r2(n(l.amt_gst)), bill_qty: r3(billQty), bill_amt: r2(billAmt),
      bal_qty: balQty, bal_amt: balAmt, age: daysBetween(l.grn_date), stores_passed_date: ['ACCEPTED', 'PARTIAL_ACCEPTED'].includes(l.qc_status) ? dstr(l.created_at) : null,
      gate_entry_no: l.entry_no, gate_inward_id: l.gate_inward_id, bill_no: bl.map(billLabel).join(', ') || null, bill_date: bl.map((b: any) => dstr(b.supplier_inv_date ?? b.bill_date)).join(', ') || null,
      prepared_by: l.prepared_by, status: balQty <= 0.001 ? 'DONE' : 'PENDING', grn_link: grnLink(mat, gid), po_link: poLink(mat, l.po_id),
      gate_link: l.gate_inward_id ? `/gate/inwards?id=${l.gate_inward_id}` : null, bill_link: bl.length ? '/procurement/supplier-bills?tab=SUPPLIER' : null });
  }
  // ---- trim GRN lines (bills link trim GRNs at header level: trx_supplier_bill.trim_grn_ids) ----
  const tl = await safe<any>(
    `SELECT l.id line_id, g.id grn_id, g.grn_no, g.grn_date, g.created_at, g.receipt_type, g.po_id, po.po_no, g.supplier_id, p.party_name, w.warehouse_name, un.unit_name,
            COALESCE(NULLIF(g.supplier_dc_no, ''), gi.supplier_dc_no) dc_no, gi.supplier_dc_date dc_date, gi.entry_no, g.gate_inward_id,
            COALESCE(t.trim_name, l.specification) item, l.color_name, l.trim_size, u.code uom, l.accepted_qty,
            COALESCE(NULLIF(l.taxable_amount, 0), l.accepted_qty * l.rate) amt, COALESCE(NULLIF(l.total_amount, 0), l.accepted_qty * l.rate) amt_gst, g.status, us.full_name prepared_by
       FROM trx_trim_grn_line l JOIN trx_trim_grn g ON g.id = l.grn_id LEFT JOIN trx_trim_po po ON po.id = g.po_id
       LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
       LEFT JOIN trx_gate_inward gi ON gi.id = g.gate_inward_id LEFT JOIN mst_trim t ON t.id = l.trim_id LEFT JOIN cfg_uom u ON u.id = l.uom_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND COALESCE(g.status, '') <> 'CANCELLED' ORDER BY g.grn_date, g.id, l.id`, [cid]);
  for (const l of tl) {
    const gid = Number(l.grn_id);
    const bl = bills.filter((b) => parseIds(b.trim_grn_ids).includes(gid));
    const inQty = n(l.accepted_qty); const inAmt = n(l.amt); const billed = bl.length > 0;
    out.push({ source: 'TRIM', grn_type: `TRIM GRN${l.receipt_type ? ` (${l.receipt_type})` : ''}`, grn_id: gid, grn_no: l.grn_no, grn_date: dstr(l.grn_date), unit: l.unit_name, location: l.warehouse_name,
      party_dc_no: l.dc_no, party_dc_date: dstr(l.dc_date), po_no: l.po_no, po_id: l.po_id, party: l.party_name, party_id: l.supplier_id,
      item: [l.item, l.color_name, l.trim_size].filter(Boolean).join(' · '), uom: l.uom, in_qty: r3(inQty), in_amt: r2(inAmt), in_amt_gst: r2(n(l.amt_gst)),
      bill_qty: billed ? r3(inQty) : 0, bill_amt: billed ? r2(inAmt) : 0, bal_qty: billed ? 0 : r3(inQty), bal_amt: billed ? 0 : r2(inAmt), age: daysBetween(l.grn_date),
      stores_passed_date: l.status === 'POSTED' ? dstr(l.created_at) : null, gate_entry_no: l.entry_no, gate_inward_id: l.gate_inward_id,
      bill_no: bl.map(billLabel).join(', ') || null, bill_date: bl.map((b) => dstr(b.supplier_inv_date ?? b.bill_date)).join(', ') || null, prepared_by: l.prepared_by,
      status: billed ? 'DONE' : 'PENDING', grn_link: `/procurement/trim/grn/${gid}`, po_link: l.po_id ? `/procurement/trim/orders/${l.po_id}` : null,
      gate_link: l.gate_inward_id ? `/gate/inwards?id=${l.gate_inward_id}` : null, bill_link: billed ? '/procurement/supplier-bills?tab=SUPPLIER' : null });
  }
  // ---- general purchase GRNs: the supplier invoice is captured on the same document (direct bill) ----
  const gp = await safe<any>(
    `SELECT l.id line_id, g.id grn_id, COALESCE(NULLIF(g.grn_no, ''), g.purchase_no) grn_no, g.purchase_date, g.created_at, g.reference_po_id, rp.purchase_no ref_po_no, g.supplier_id, p.party_name,
            g.supplier_inv_no, g.supplier_inv_date, g.approval_state, gi.entry_no, gi.supplier_dc_no, gi.supplier_dc_date, g.gate_inward_id, w.warehouse_name, un.unit_name,
            l.item_description, u.code uom, l.qty, l.amount, l.tax_amount, us.full_name prepared_by
       FROM trx_general_purchase_line l JOIN trx_general_purchase g ON g.id = l.purchase_id LEFT JOIN trx_general_purchase rp ON rp.id = g.reference_po_id
       LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN trx_gate_inward gi ON gi.id = g.gate_inward_id LEFT JOIN mst_warehouse w ON w.id = l.warehouse_id
       LEFT JOIN mst_unit un ON un.id = w.unit_id LEFT JOIN cfg_uom u ON u.id = l.uom_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND g.doc_kind = 'GRN' AND g.is_deleted = 0 AND g.approval_state NOT IN ('CANCELLED', 'REJECTED') ORDER BY g.purchase_date, g.id, l.id`, [cid]);
  for (const l of gp) {
    const billed = !!String(l.supplier_inv_no ?? '').trim();
    const inQty = n(l.qty); const inAmt = n(l.amount);
    out.push({ source: 'GENERAL', grn_type: 'GENERAL PURCHASE GRN', grn_id: Number(l.grn_id), grn_no: l.grn_no, grn_date: dstr(l.purchase_date), unit: l.unit_name, location: l.warehouse_name,
      party_dc_no: l.supplier_dc_no, party_dc_date: dstr(l.supplier_dc_date), po_no: l.ref_po_no, po_id: l.reference_po_id, party: l.party_name, party_id: l.supplier_id,
      item: l.item_description, uom: l.uom, in_qty: r3(inQty), in_amt: r2(inAmt), in_amt_gst: r2(inAmt + n(l.tax_amount)), bill_qty: billed ? r3(inQty) : 0, bill_amt: billed ? r2(inAmt) : 0,
      bal_qty: billed ? 0 : r3(inQty), bal_amt: billed ? 0 : r2(inAmt), age: daysBetween(l.purchase_date), stores_passed_date: ['APPROVED', 'POSTED'].includes(l.approval_state) ? dstr(l.created_at) : null,
      gate_entry_no: l.entry_no, gate_inward_id: l.gate_inward_id, bill_no: billed ? l.supplier_inv_no : null, bill_date: billed ? dstr(l.supplier_inv_date) : null, prepared_by: l.prepared_by,
      status: billed ? 'DONE' : 'PENDING', grn_link: `/procurement/general-purchases/${l.grn_id}`, po_link: l.reference_po_id ? `/procurement/general-orders/${l.reference_po_id}` : null,
      gate_link: l.gate_inward_id ? `/gate/inwards?id=${l.gate_inward_id}` : null, bill_link: billed ? `/procurement/general-purchases/${l.grn_id}` : null });
  }
  // ---- billable process inwards (fabric / yarn process, knitting) — reuse the GRN bill-status engine ----
  const proc = (await grnBillRows(cid, 9999)).filter((r) => r.source !== 'PURCHASE' && r.source !== 'TRIM');
  for (const r of proc) {
    const billed = r.status === 'RECEIVED';
    out.push({ source: r.source, grn_type: `${r.source.replace('_', ' ')} INWARD`, grn_id: r.grn_id, grn_no: r.grn_no, grn_date: dstr(r.grn_date), unit: null, location: null,
      party_dc_no: r.supplier_inv_no, party_dc_date: null, po_no: r.po_nos, po_id: null, party: r.supplier, party_id: r.supplier_id, item: r.material, uom: 'KG',
      in_qty: r.grn_qty, in_amt: r.grn_value, in_amt_gst: r.grn_value, bill_qty: billed ? r.grn_qty : 0, bill_amt: billed ? r.grn_value : 0,
      bal_qty: billed ? 0 : r.grn_qty, bal_amt: billed ? 0 : r.grn_value, age: r.days, stores_passed_date: dstr(r.grn_date), gate_entry_no: null, gate_inward_id: null,
      bill_no: r.bill_nos, bill_date: null, prepared_by: null, status: billed ? 'DONE' : 'PENDING', grn_link: r.link, po_link: null, gate_link: null,
      bill_link: billed ? (r.source === 'KNITTING' ? '/procurement/supplier-bills?tab=KNITTING' : r.source === 'FABRIC_PROCESS' ? '/production/fabric-process/bills' : '/production/yarn-process/bills') : null });
  }
  // ---- billable garment job-work receipts (process DC inward) against contractor bills ----
  const jr = await safe<any>(
    `SELECT r.id, r.receipt_no, r.receipt_date, r.party_dc_no, r.party_dc_date, r.received_qty, r.total_amount, r.rate, r.vendor_id, p.party_name, jc.challan_no, jc.id challan_id,
            r.gate_inward_id, gi.entry_no, cb.bill_no, cb.bill_date, cb.status bill_status, w.warehouse_name, un.unit_name, us.full_name prepared_by
       FROM trx_jobwork_receipt r LEFT JOIN trx_jobwork_challan jc ON jc.id = r.challan_id LEFT JOIN mst_party p ON p.id = r.vendor_id
       LEFT JOIN trx_gate_inward gi ON gi.id = r.gate_inward_id LEFT JOIN trx_contractor_bill cb ON cb.id = r.contractor_bill_id
       LEFT JOIN mst_warehouse w ON w.id = r.to_warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id LEFT JOIN mst_user us ON us.id = r.created_by
      WHERE r.company_id = ? AND r.billable = 1 AND r.vendor_id IS NOT NULL AND COALESCE(r.status, '') NOT IN ('CANCELLED', 'DRAFT') ORDER BY r.receipt_date, r.id`, [cid]);
  for (const r of jr) {
    const billed = !!r.bill_no && r.bill_status !== 'CANCELLED';
    const inQty = n(r.received_qty); const inAmt = n(r.total_amount) || inQty * n(r.rate);
    out.push({ source: 'JOBWORK', grn_type: 'PROCESS INWARD (GARMENT)', grn_id: Number(r.id), grn_no: r.receipt_no, grn_date: dstr(r.receipt_date), unit: r.unit_name, location: r.warehouse_name,
      party_dc_no: r.party_dc_no, party_dc_date: dstr(r.party_dc_date), po_no: r.challan_no, po_id: r.challan_id, party: r.party_name, party_id: r.vendor_id, item: 'Garment job work', uom: 'PCS',
      in_qty: inQty, in_amt: r2(inAmt), in_amt_gst: r2(inAmt), bill_qty: billed ? inQty : 0, bill_amt: billed ? r2(inAmt) : 0, bal_qty: billed ? 0 : inQty, bal_amt: billed ? 0 : r2(inAmt),
      age: daysBetween(r.receipt_date), stores_passed_date: dstr(r.receipt_date), gate_entry_no: r.entry_no, gate_inward_id: r.gate_inward_id, bill_no: billed ? r.bill_no : null,
      bill_date: billed ? dstr(r.bill_date) : null, prepared_by: r.prepared_by, status: billed ? 'DONE' : 'PENDING', grn_link: `/production/jobwork-receipts?id=${r.id}`,
      po_link: r.challan_id ? `/production/jobwork-challans?dc=${r.challan_id}` : null, gate_link: r.gate_inward_id ? `/gate/inwards?id=${r.gate_inward_id}` : null,
      bill_link: billed ? '/production/contractor-bills' : null });
  }
  return out;
}

clientReportsBRouter.get('/b/grir', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = z.object({ status: STATUS, source: z.string().optional(), party_id: optId, dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  let rows = await grirRows(cidOf(req));
  if (q.status !== 'all') rows = rows.filter((r) => r.status === (q.status === 'done' ? 'DONE' : 'PENDING'));
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.party_id) rows = rows.filter((r) => r.party_id === q.party_id);
  if (q.dateFrom || q.dateTo) rows = rows.filter((r) => inRange(r.grn_date, q.dateFrom, q.dateTo));
  res.json({ data: rows, meta: { footnotes: [
    'Sources: yarn / fabric GRNs raised against a PO (trx_grn), trim GRNs, general purchase GRNs, fabric / yarn process inwards, knitting GRNs and billable garment job-work receipts.',
    'Bill qty / amount: supplier bill lines matched to the GRN line; a bill linked to the GRN only at header level (or a trim / process bill) covers the whole GRN. General purchase GRNs count as billed when the supplier invoice no. is entered on them.',
    'Stores passed date = date the GRN was posted with QC accepted. Process inwards carry KG and their quotation value where one exists.',
  ] } });
}));

// =====================================================================================
// 2. PO vs GRN vs Bill pass (quantity & rate)
// =====================================================================================
clientReportsBRouter.get('/b/po-grn-bill', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ status: z.enum(['all', 'grn_pending', 'bill_pending', 'complete', 'variance']).default('all'), party_id: optId,
    dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  const out: any[] = [];
  const po = await query<any>(
    `SELECT pl.id po_line_id, po.id po_id, po.po_no, po.po_date, po.supplier_id, p.party_name, pl.material_type, u.code uom, pl.qty po_qty, pl.rate po_rate, pl.short_closed,
            COALESCE(y.yarn_name, f.fabric_name, t.trim_name, pl.description, pl.yarn_count_str) item, pl.color_name,
            (SELECT COALESCE(SUM(gl.accepted_qty), 0) FROM trx_grn_line gl WHERE gl.po_line_id = pl.id) grn_qty,
            (SELECT COALESCE(SUM(COALESCE(NULLIF(gl.taxable_amount, 0), gl.accepted_qty * gl.rate)), 0) FROM trx_grn_line gl WHERE gl.po_line_id = pl.id) grn_amt,
            (SELECT GROUP_CONCAT(DISTINCT g.grn_no SEPARATOR ', ') FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id WHERE gl.po_line_id = pl.id) grn_nos,
            (SELECT MIN(gl.grn_id) FROM trx_grn_line gl WHERE gl.po_line_id = pl.id) first_grn_id,
            (SELECT COALESCE(SUM(bl.bill_qty), 0) FROM trx_supplier_bill_line bl JOIN trx_supplier_bill b ON b.id = bl.bill_id AND b.status <> 'CANCELLED'
              WHERE bl.po_line_id = pl.id OR bl.grn_line_id IN (SELECT gl.id FROM trx_grn_line gl WHERE gl.po_line_id = pl.id)) bill_qty,
            (SELECT COALESCE(SUM(bl.amount), 0) FROM trx_supplier_bill_line bl JOIN trx_supplier_bill b ON b.id = bl.bill_id AND b.status <> 'CANCELLED'
              WHERE bl.po_line_id = pl.id OR bl.grn_line_id IN (SELECT gl.id FROM trx_grn_line gl WHERE gl.po_line_id = pl.id)) bill_amt,
            (SELECT GROUP_CONCAT(DISTINCT b.bill_no SEPARATOR ', ') FROM trx_supplier_bill_line bl JOIN trx_supplier_bill b ON b.id = bl.bill_id AND b.status <> 'CANCELLED'
              WHERE bl.po_line_id = pl.id OR bl.grn_line_id IN (SELECT gl.id FROM trx_grn_line gl WHERE gl.po_line_id = pl.id)) bill_nos
       FROM trx_purchase_order_line pl JOIN trx_purchase_order po ON po.id = pl.po_id LEFT JOIN mst_party p ON p.id = po.supplier_id
       LEFT JOIN mst_yarn y ON y.id = pl.yarn_id LEFT JOIN mst_fabric f ON f.id = pl.fabric_id LEFT JOIN mst_trim t ON t.id = pl.trim_id LEFT JOIN cfg_uom u ON u.id = pl.uom_id
      WHERE po.company_id = ? AND po.is_deleted = 0 AND COALESCE(po.approval_state, '') NOT IN ('CANCELLED', 'REJECTED') ORDER BY po.po_date, po.id, pl.id`, [cid]);
  for (const l of po) out.push({ ...l, kind: `${l.material_type ?? ''} PO`, po_link: poLink(String(l.material_type ?? ''), l.po_id),
    grn_link: l.first_grn_id ? grnLink(String(l.material_type ?? ''), Number(l.first_grn_id)) : null });
  const tp = await safe<any>(
    `SELECT pl.id po_line_id, po.id po_id, po.po_no, po.po_date, po.supplier_id, p.party_name, 'TRIM' material_type, u.code uom, pl.order_qty po_qty, pl.rate po_rate, pl.short_closed,
            COALESCE(t.trim_name, pl.specification) item, pl.color_name,
            (SELECT COALESCE(SUM(gl.accepted_qty), 0) FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id AND COALESCE(g.status, '') <> 'CANCELLED' WHERE gl.po_line_id = pl.id) grn_qty,
            (SELECT COALESCE(SUM(COALESCE(NULLIF(gl.taxable_amount, 0), gl.accepted_qty * gl.rate)), 0) FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id AND COALESCE(g.status, '') <> 'CANCELLED' WHERE gl.po_line_id = pl.id) grn_amt,
            (SELECT GROUP_CONCAT(DISTINCT g.grn_no SEPARATOR ', ') FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id AND COALESCE(g.status, '') <> 'CANCELLED' WHERE gl.po_line_id = pl.id) grn_nos,
            (SELECT JSON_ARRAYAGG(gl.grn_id) FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id AND COALESCE(g.status, '') <> 'CANCELLED' WHERE gl.po_line_id = pl.id) grn_ids_json
       FROM trx_trim_po_line pl JOIN trx_trim_po po ON po.id = pl.po_id LEFT JOIN mst_party p ON p.id = po.supplier_id LEFT JOIN mst_trim t ON t.id = pl.trim_id LEFT JOIN cfg_uom u ON u.id = pl.uom_id
      WHERE po.company_id = ? AND COALESCE(po.status, '') <> 'CANCELLED' ORDER BY po.po_date, po.id, pl.id`, [cid]);
  if (tp.length) {
    const bills = await query<any>(`SELECT bill_no, trim_grn_ids FROM trx_supplier_bill WHERE company_id = ? AND status <> 'CANCELLED' AND trim_grn_ids IS NOT NULL`, [cid]);
    const lineQty = await query<any>(
      `SELECT gl.po_line_id, gl.grn_id, SUM(gl.accepted_qty) qty, SUM(COALESCE(NULLIF(gl.taxable_amount, 0), gl.accepted_qty * gl.rate)) amt
         FROM trx_trim_grn_line gl JOIN trx_trim_grn g ON g.id = gl.grn_id WHERE g.company_id = ? AND gl.po_line_id IS NOT NULL GROUP BY gl.po_line_id, gl.grn_id`, [cid]);
    for (const l of tp) {
      const gids = [...new Set(parseIds(l.grn_ids_json))];
      let bq = 0, ba = 0; const bn = new Set<string>();
      for (const gid of gids) {
        const bl = bills.filter((b) => parseIds(b.trim_grn_ids).includes(gid));
        if (!bl.length) continue;
        bl.forEach((b) => bn.add(b.bill_no));
        const lq = lineQty.find((x) => Number(x.po_line_id) === Number(l.po_line_id) && Number(x.grn_id) === gid);
        bq += n(lq?.qty); ba += n(lq?.amt);
      }
      out.push({ ...l, grn_ids_json: undefined, bill_qty: bq, bill_amt: ba, bill_nos: [...bn].join(', ') || null, kind: 'TRIM PO',
        po_link: `/procurement/trim/orders/${l.po_id}`, grn_link: gids[0] ? `/procurement/trim/grn/${gids[0]}` : null });
    }
  }
  let rows = out.map((l) => {
    const poQty = n(l.po_qty), grnQty = n(l.grn_qty), billQty = n(l.bill_qty);
    const grnRate = grnQty ? n(l.grn_amt) / grnQty : 0; const billRate = billQty ? n(l.bill_amt) / billQty : 0;
    const qtyVar = r3(grnQty - poQty); const rateVar = billQty ? r2(billRate - n(l.po_rate)) : 0;
    const status = grnQty <= 0 ? 'GRN PENDING' : billQty + 0.001 < grnQty ? 'BILL PENDING' : 'COMPLETE';
    return { kind: l.kind, po_id: l.po_id, po_no: l.po_no, po_date: dstr(l.po_date), party: l.party_name, party_id: l.supplier_id, item: [l.item, l.color_name].filter(Boolean).join(' · '),
      uom: l.uom, po_qty: r3(poQty), po_rate: r2(n(l.po_rate)), po_amt: r2(poQty * n(l.po_rate)), grn_nos: l.grn_nos, grn_qty: r3(grnQty), grn_rate: r2(grnRate), grn_amt: r2(n(l.grn_amt)),
      bill_nos: l.bill_nos, bill_qty: r3(billQty), bill_rate: r2(billRate), bill_amt: r2(n(l.bill_amt)), po_grn_bal: r3(Math.max(0, poQty - grnQty)), grn_bill_bal: r3(Math.max(0, grnQty - billQty)),
      qty_variance: qtyVar, rate_variance: rateVar, short_closed: l.short_closed ? 'Yes' : 'No', status, po_link: l.po_link, grn_link: l.grn_link,
      bill_link: billQty ? '/procurement/supplier-bills?tab=SUPPLIER' : null };
  });
  if (q.party_id) rows = rows.filter((r) => r.party_id === q.party_id);
  if (q.dateFrom || q.dateTo) rows = rows.filter((r) => inRange(r.po_date, q.dateFrom, q.dateTo));
  if (q.status === 'grn_pending') rows = rows.filter((r) => r.status === 'GRN PENDING');
  if (q.status === 'bill_pending') rows = rows.filter((r) => r.status === 'BILL PENDING');
  if (q.status === 'complete') rows = rows.filter((r) => r.status === 'COMPLETE');
  if (q.status === 'variance') rows = rows.filter((r) => Math.abs(r.rate_variance) > 0.009 || (r.bill_qty && Math.abs(r.bill_qty - r.grn_qty) > 0.001));
  res.json({ data: rows, meta: { footnotes: [
    'One row per PO line (yarn / fabric / general material PO and trim PO). GRN qty = accepted qty; rates are amount ÷ qty at each stage. Rate variance = bill rate − PO rate.',
    'Trim bills are linked to trim GRNs at header level, so a billed trim GRN counts its full accepted qty as billed.',
  ] } });
}));

// =====================================================================================
// 3. Our DC vs gate outward (gate delivery pending register)
// =====================================================================================
async function outwardDcs(cid: number) {
  const passes = await query<any>(
    `SELECT g.id, g.pass_no, g.pass_date, g.pass_time, g.status, g.ref_type, g.ref_id, g.ref_no, g.security_guard FROM trx_gate_outward g
      WHERE g.company_id = ? AND g.status <> 'DRAFT'`, [cid]);
  const byRef = new Map<string, any>(); const byNo = new Map<string, any>(); const byId = new Map<number, any>();
  for (const p of passes) {
    byId.set(Number(p.id), p);
    if (p.ref_type && p.ref_id) byRef.set(`${p.ref_type}:${p.ref_id}`, p);
    if (p.ref_no) byNo.set(String(p.ref_no).trim().toUpperCase(), p);
  }
  const find = (refType: string, id: number, no: string | null, passId?: number | null) =>
    (passId ? byId.get(Number(passId)) : null) ?? byRef.get(`${refType}:${id}`) ?? (no ? byNo.get(String(no).trim().toUpperCase()) : null) ?? null;
  const dcs: any[] = [];
  const push = (d: any) => dcs.push(d);
  // process / job-work DCs (garment, fabric job work, in-house unit DCs)
  for (const r of await safe<any>(
    `SELECT jc.id, jc.challan_no, jc.challan_date, jc.created_at, jc.status, jc.total_qty, jc.gate_outward_id, jc.dc_kind, jc.closed_at, jc.close_reason,
            fw.warehouse_name from_loc, COALESCE(v.party_name, CONCAT(un.unit_name, ' (in-house unit)')) to_party, us.full_name prepared_by, iu.full_name incharge,
            COALESCE(wu.unit_name, un.unit_name) unit_name, ps.stage_name
       FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN mst_unit un ON un.id = jc.unit_id LEFT JOIN mst_warehouse fw ON fw.id = jc.from_warehouse_id
       LEFT JOIN mst_unit wu ON wu.id = fw.unit_id LEFT JOIN mst_user us ON us.id = jc.created_by LEFT JOIN mst_user iu ON iu.id = jc.issued_by LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE jc.company_id = ? AND jc.status NOT IN ('DRAFT', 'CANCELLED')`, [cid]))
    push({ del_type: `Process DC${r.stage_name ? ` — ${r.stage_name}` : ''}${r.dc_kind ? ` (${r.dc_kind})` : ''}`, ref_type: 'JW_CHALLAN', id: r.id, del_no: r.challan_no, del_date: r.challan_date,
      created_on: r.created_at, from_location: r.from_loc, to_party: r.to_party, prepared_by: r.prepared_by, incharge: r.incharge, unit: r.unit_name, del_qty: n(r.total_qty), uom: 'PCS',
      job_close: r.closed_at, job_status: r.status, pass: find('JW_CHALLAN', r.id, r.challan_no, r.gate_outward_id), link: `/production/jobwork-challans?dc=${r.id}` });
  for (const r of await safe<any>(
    `SELECT o.id, o.fpo_no, o.fpo_date, o.created_at, o.status, o.input_weight_kg, o.sub_process, o.updated_at, fw.warehouse_name from_loc, COALESCE(v.party_name, o.to_location) to_party,
            us.full_name prepared_by, cu.full_name incharge, un.unit_name
       FROM trx_fabric_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id LEFT JOIN mst_warehouse fw ON fw.id = o.from_warehouse_id LEFT JOIN mst_unit un ON un.id = fw.unit_id
       LEFT JOIN mst_user us ON us.id = o.created_by LEFT JOIN mst_user cu ON cu.id = o.confirmed_by
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT', 'CANCELLED')`, [cid]))
    push({ del_type: `Fabric process DC (${String(r.sub_process ?? '').toLowerCase()})`, ref_type: 'FABRIC_PROCESS_DC', id: r.id, del_no: r.fpo_no, del_date: r.fpo_date, created_on: r.created_at,
      from_location: r.from_loc, to_party: r.to_party, prepared_by: r.prepared_by, incharge: r.incharge, unit: r.unit_name, del_qty: n(r.input_weight_kg), uom: 'KG',
      job_close: ['COMPLETED', 'CLOSED'].includes(r.status) ? r.updated_at : null, job_status: r.status, pass: find('FABRIC_PROCESS_DC', r.id, r.fpo_no), link: `/production/fabric-process/outward?id=${r.id}` });
  for (const r of await safe<any>(
    `SELECT o.id, o.ypo_no, o.ypo_date, o.created_at, o.status, o.total_kg, o.process_code, fw.warehouse_name from_loc, COALESCE(v.party_name, o.to_location) to_party,
            us.full_name prepared_by, cu.full_name incharge, un.unit_name
       FROM trx_yarn_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id LEFT JOIN mst_warehouse fw ON fw.id = o.from_warehouse_id LEFT JOIN mst_unit un ON un.id = fw.unit_id
       LEFT JOIN mst_user us ON us.id = o.created_by LEFT JOIN mst_user cu ON cu.id = o.confirmed_by
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT', 'CANCELLED')`, [cid]))
    push({ del_type: `Yarn process DC (${String(r.process_code ?? '').toLowerCase()})`, ref_type: 'YARN_PROCESS_DC', id: r.id, del_no: r.ypo_no, del_date: r.ypo_date, created_on: r.created_at,
      from_location: r.from_loc, to_party: r.to_party, prepared_by: r.prepared_by, incharge: r.incharge, unit: r.unit_name, del_qty: n(r.total_kg), uom: 'KG',
      job_close: null, job_status: r.status, pass: find('YARN_PROCESS_DC', r.id, r.ypo_no), link: `/production/yarn-process/outward?id=${r.id}` });
  for (const r of await safe<any>(
    `SELECT MIN(i.id) id, i.dc_no, MIN(i.issue_date) dc_date, MIN(i.created_at) created_at, MAX(i.src_type) src_type, MAX(v.party_name) to_party, SUM(i.issued_qty_kg) kg,
            MAX(fw.warehouse_name) from_loc, MAX(un.unit_name) unit_name, MAX(us.full_name) prepared_by, MAX(kd.status) kd_status, MAX(kd.closed_at) closed_at
       FROM trx_process_issue i LEFT JOIN mst_party v ON v.id = i.vendor_id LEFT JOIN mst_warehouse fw ON fw.id = i.warehouse_id LEFT JOIN mst_unit un ON un.id = fw.unit_id
       LEFT JOIN mst_user us ON us.id = i.created_by LEFT JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
      WHERE i.company_id = ? AND i.dc_no IS NOT NULL AND i.dc_no <> '' AND i.src_type IN ('KNITTING_PROGRAM', 'YARN_PROCESS') GROUP BY i.dc_no`, [cid])) {
    const knit = r.src_type === 'KNITTING_PROGRAM';
    push({ del_type: knit ? 'Knitting DC (yarn outward)' : 'Yarn process DC (issue)', ref_type: knit ? 'KNITTING_DC' : 'YARN_DC', id: r.id, del_no: r.dc_no, del_date: r.dc_date, created_on: r.created_at,
      from_location: r.from_loc, to_party: r.to_party, prepared_by: r.prepared_by, incharge: null, unit: r.unit_name, del_qty: r3(n(r.kg)), uom: 'KG', job_close: r.closed_at,
      job_status: r.kd_status ?? 'ISSUED', pass: find(knit ? 'KNITTING_DC' : 'YARN_DC', r.id, r.dc_no), link: knit ? '/production/knitting-programs' : '/production/yarn-process/outward' });
  }
  for (const r of await safe<any>(
    `SELECT r.id, r.return_no, COALESCE(NULLIF(r.return_dc_no, ''), r.return_no) dc_no, COALESCE(r.return_dc_date, r.return_date) dc_date, r.created_at, r.status, r.total_qty, r.gate_outward_id,
            w.warehouse_name from_loc, v.party_name to_party, us.full_name prepared_by, au.full_name incharge, un.unit_name
       FROM trx_purchase_return r LEFT JOIN mst_party v ON v.id = r.supplier_id LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
       LEFT JOIN mst_user us ON us.id = r.created_by LEFT JOIN mst_user au ON au.id = r.approved_by
      WHERE r.company_id = ? AND COALESCE(r.status, '') NOT IN ('DRAFT', 'CANCELLED')`, [cid]))
    push({ del_type: 'Purchase return DC', ref_type: 'PURCHASE_RETURN', id: r.id, del_no: r.dc_no, del_date: r.dc_date, created_on: r.created_at, from_location: r.from_loc, to_party: r.to_party,
      prepared_by: r.prepared_by, incharge: r.incharge, unit: r.unit_name, del_qty: n(r.total_qty), uom: '', job_close: null, job_status: r.status,
      pass: find('PURCHASE_RETURN', r.id, r.dc_no, r.gate_outward_id) ?? find('PURCHASE_RETURN', r.id, r.return_no), link: `/procurement/returns/${r.id}` });
  for (const r of await safe<any>(
    `SELECT d.id, d.dispatch_no, d.dispatch_date, d.created_at, d.total_qty, d.delivery_location, b.party_name to_party, us.full_name prepared_by
       FROM trx_dispatch d LEFT JOIN mst_party b ON b.id = d.buyer_id LEFT JOIN mst_user us ON us.id = d.created_by WHERE d.company_id = ?`, [cid]))
    push({ del_type: 'Dispatch / delivery challan', ref_type: 'DISPATCH', id: r.id, del_no: r.dispatch_no, del_date: r.dispatch_date, created_on: r.created_at, from_location: null,
      to_party: [r.to_party, r.delivery_location].filter(Boolean).join(' — '), prepared_by: r.prepared_by, incharge: null, unit: null, del_qty: n(r.total_qty), uom: 'PCS',
      job_close: null, job_status: 'DISPATCHED', pass: find('DISPATCH', r.id, r.dispatch_no), link: '/logistics/dispatches' });
  return dcs.map((d) => {
    const p = d.pass;
    const gateAt = p ? `${dstr(p.pass_date)}${p.pass_time ? ` ${String(p.pass_time).slice(0, 5)}` : ''}` : null;
    return { del_type: d.del_type, del_no: d.del_no, del_date: dstr(d.del_date), created_on: d.created_on, from_location: d.from_location, to_party: d.to_party,
      prepared_by: d.prepared_by, gate_pass_no: p?.pass_no ?? null, gate_entry_time: gateAt, gate_status: p ? p.status : 'PENDING', unit: d.unit, del_qty: r3(d.del_qty), uom: d.uom,
      incharge: d.incharge ?? p?.security_guard ?? null, age: daysBetween(d.del_date, p ? p.pass_date : undefined), job_close: dstr(d.job_close), job_status: d.job_status,
      status: p ? 'DONE' : 'PENDING', dc_link: d.link, gate_link: p ? `/gate/outwards?id=${p.id}` : null, ref_type: d.ref_type };
  });
}

clientReportsBRouter.get('/b/dc-gate-outward', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = z.object({ status: STATUS, dc_type: z.string().optional(), dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  let rows = await outwardDcs(cidOf(req));
  if (q.status !== 'all') rows = rows.filter((r) => r.status === (q.status === 'done' ? 'DONE' : 'PENDING'));
  if (q.dc_type) rows = rows.filter((r) => r.ref_type === q.dc_type);
  if (q.dateFrom || q.dateTo) rows = rows.filter((r) => inRange(r.del_date, q.dateFrom, q.dateTo));
  rows.sort((a, b) => String(a.del_date).localeCompare(String(b.del_date)));
  res.json({ data: rows, meta: { footnotes: [
    'DCs covered: process / job-work DCs (incl. in-house unit DCs), fabric process DCs, yarn process DCs, knitting / yarn issue DCs, purchase return DCs and dispatches. Draft and cancelled DCs are left out.',
    'A DC is matched to its gate pass by the DC\'s gate pass link, the pass reference (type + id) or the DC number on the pass. Age = DC date → gate-out date (or today while pending).',
    'General deliveries are not a separate document in the ERP yet, so they do not appear here.',
  ] } });
}));

// =====================================================================================
// 4. Party DC vs gate inward vs GRN
// =====================================================================================
async function gateInwardRows(cid: number) {
  const gi = await query<any>(
    `SELECT g.id, g.entry_no, g.entry_date, g.entry_time, g.entry_type, g.material_type, g.supplier_dc_no, g.supplier_dc_date, g.vehicle_no, g.status, g.remarks,
            g.package_count, g.net_weight_kg, p.party_name, g.party_id, w.warehouse_name, un.unit_name, us.username, us.full_name
       FROM trx_gate_inward g LEFT JOIN mst_party p ON p.id = g.party_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
       LEFT JOIN mst_user us ON us.id = g.created_by WHERE g.company_id = ? ORDER BY g.entry_date, g.id`, [cid]);
  // every receipt document that can be made against a gate inward
  const docs = await safe<any>(
    `SELECT gate_inward_id gid, grn_no doc_no, created_at, 'GRN' kind, id FROM trx_grn WHERE company_id = ? AND gate_inward_id IS NOT NULL
     UNION ALL SELECT gate_inward_id, grn_no, created_at, 'TRIM_GRN', id FROM trx_trim_grn WHERE company_id = ? AND gate_inward_id IS NOT NULL AND COALESCE(status, '') <> 'CANCELLED'
     UNION ALL SELECT gate_inward_id, COALESCE(NULLIF(grn_no, ''), purchase_no), created_at, 'GENERAL_GRN', id FROM trx_general_purchase WHERE company_id = ? AND gate_inward_id IS NOT NULL AND is_deleted = 0
     UNION ALL SELECT gate_inward_id, inward_no, created_at, 'FABRIC_PROCESS_INWARD', id FROM trx_fabric_process_inward WHERE company_id = ? AND gate_inward_id IS NOT NULL
     UNION ALL SELECT gate_inward_id, inward_no, created_at, 'YARN_PROCESS_INWARD', id FROM trx_yarn_process_inward WHERE company_id = ? AND gate_inward_id IS NOT NULL
     UNION ALL SELECT gate_inward_id, receipt_no, created_at, 'JOBWORK_RECEIPT', id FROM trx_jobwork_receipt WHERE company_id = ? AND gate_inward_id IS NOT NULL
     UNION ALL SELECT gate_inward_id, jwin_no, created_at, 'JOBWORK_IN', id FROM trx_jobwork_in WHERE company_id = ? AND gate_inward_id IS NOT NULL`, [cid, cid, cid, cid, cid, cid, cid]);
  const byGate = new Map<number, any[]>();
  for (const d of docs) byGate.set(Number(d.gid), [...(byGate.get(Number(d.gid)) ?? []), d]);
  const docLink = (d: any) => ({
    GRN: '/procurement/grns', TRIM_GRN: `/procurement/trim/grn/${d.id}`, GENERAL_GRN: `/procurement/general-purchases/${d.id}`,
    FABRIC_PROCESS_INWARD: `/production/fabric-process/inward?id=${d.id}`, YARN_PROCESS_INWARD: `/production/yarn-process/inward?id=${d.id}`,
    JOBWORK_RECEIPT: `/production/jobwork-receipts?id=${d.id}`, JOBWORK_IN: '/production/jobwork-ins',
  } as Record<string, string>)[d.kind] ?? null;
  return gi.map((g) => {
    const ds = (byGate.get(Number(g.id)) ?? []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const done = ds.length > 0 || g.status === 'GRN_COMPLETED';
    const closed = ['REJECTED', 'CANCELLED'].includes(g.status);
    const grnAt = ds[0]?.created_at ?? null;
    const kg = n(g.net_weight_kg);
    return { gate_entry_at: `${dstr(g.entry_date)}${g.entry_time ? ` ${String(g.entry_time).slice(0, 5)}` : ''}`, gate_inward_id: g.id, gate_inward_no: g.entry_no, entry_date: dstr(g.entry_date),
      party_dc_no: g.supplier_dc_no, party_dc_date: dstr(g.supplier_dc_date), vehicle_no: g.vehicle_no, party: g.party_name, party_id: g.party_id,
      department: [g.material_type, String(g.entry_type ?? '').replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · '),
      delivery_qty: kg > 0 ? r3(kg) : n(g.package_count), uom: kg > 0 ? 'KG' : 'PKG', inward_status: g.status,
      remarks: g.remarks, grn_nos: ds.map((d) => d.doc_no).join(', ') || null, grn_created_on: grnAt, unit: g.unit_name ?? g.warehouse_name,
      user: [g.username, g.full_name].filter(Boolean).join(' / ') || null,
      dc_to_gate_days: g.supplier_dc_date ? daysBetween(g.supplier_dc_date, g.entry_date) : null,
      age: daysBetween(g.entry_date, done ? (grnAt ?? undefined) : undefined),
      status: done ? 'DONE' : closed ? 'CLOSED' : 'PENDING', gate_link: `/gate/inwards?id=${g.id}`, grn_link: ds[0] ? docLink(ds[0]) : null };
  });
}

clientReportsBRouter.get('/b/dc-inward-grn', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = z.object({ status: STATUS, party_id: optId, dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  let rows = await gateInwardRows(cidOf(req));
  if (q.status === 'done') rows = rows.filter((r) => r.status === 'DONE');
  if (q.status === 'pending') rows = rows.filter((r) => r.status === 'PENDING');
  if (q.party_id) rows = rows.filter((r) => r.party_id === q.party_id);
  if (q.dateFrom || q.dateTo) rows = rows.filter((r) => inRange(r.entry_date, q.dateFrom, q.dateTo));
  res.json({ data: rows, meta: { footnotes: [
    'GRN done = any receipt made against the gate entry (yarn / fabric / trim / general GRN, fabric / yarn process inward, job-work receipt, job-work-in) or the entry marked GRN completed.',
    'Gate inward has no item lines: Delivery qty is the net weight (KG) when weighed, else the package count. Department = material group · inward type.',
    'Age = gate entry → first GRN (or today while pending).',
  ] } });
}));

/** Party DC received without a gate inward (GRN / process inward recorded against a party DC, no gate entry) */
clientReportsBRouter.get('/b/dc-without-gate', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  const rows = await safe<any>(
    `SELECT 'Yarn / fabric GRN' doc_type, g.id, g.grn_no doc_no, g.grn_date doc_date, g.supplier_dc_no party_dc_no, p.party_name party, g.created_at, us.full_name prepared_by,
            (SELECT MAX(material_type) FROM trx_grn_line WHERE grn_id = g.id) mat
       FROM trx_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND g.gate_inward_id IS NULL AND COALESCE(g.supplier_dc_no, '') <> ''
     UNION ALL
     SELECT 'Trim GRN', g.id, g.grn_no, g.grn_date, g.supplier_dc_no, p.party_name, g.created_at, us.full_name, 'TRIM'
       FROM trx_trim_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND g.gate_inward_id IS NULL AND COALESCE(g.supplier_dc_no, '') <> '' AND COALESCE(g.status, '') <> 'CANCELLED'
     UNION ALL
     SELECT 'Process inward (garment)', r.id, r.receipt_no, r.receipt_date, r.party_dc_no, p.party_name, r.created_at, us.full_name, 'JOBWORK'
       FROM trx_jobwork_receipt r LEFT JOIN mst_party p ON p.id = r.vendor_id LEFT JOIN mst_user us ON us.id = r.created_by
      WHERE r.company_id = ? AND r.gate_inward_id IS NULL AND COALESCE(r.party_dc_no, '') <> ''
     ORDER BY doc_date`, [cid, cid, cid]);
  const data = rows.filter((r) => inRange(r.doc_date, q.dateFrom, q.dateTo)).map((r) => ({
    doc_type: r.doc_type, doc_no: r.doc_no, doc_date: dstr(r.doc_date), party_dc_no: r.party_dc_no, party: r.party, prepared_by: r.prepared_by, created_on: r.created_at,
    age: daysBetween(r.doc_date),
    doc_link: r.mat === 'TRIM' ? `/procurement/trim/grn/${r.id}` : r.mat === 'JOBWORK' ? `/production/jobwork-receipts?id=${r.id}` : grnLink(String(r.mat ?? ''), Number(r.id)) }));
  res.json({ data, meta: { footnotes: ['Receipts recorded against a party DC with no gate inward entry — the client rule is that every GRN is made by selecting a gate inward number.'] } });
}));

// =====================================================================================
// 5. Consolidated stock statement
// =====================================================================================
const stockQ = z.object({
  asOn: isoDate.optional(), item_group: z.string().optional(), unit_id: optId, warehouse_id: optId, so_id: optId, buyer_id: optId,
  order_status: z.enum(['all', 'open', 'closed']).default('all'), order_type: z.string().optional(), bucket: z.string().optional(),
});
type StockQ = z.infer<typeof stockQ>;

async function soFilter(cid: number, q: StockQ) {
  const active = !!(q.so_id || q.buyer_id || q.order_status !== 'all' || q.order_type);
  if (!active) return null;
  const sos = await query<any>(
    `SELECT so.id, so.io_no, so.so_no FROM trx_sales_order so LEFT JOIN cfg_status s ON s.id = so.status_id
      WHERE so.company_id = ? AND so.is_deleted = 0 ${q.so_id ? 'AND so.id = ?' : ''} ${q.buyer_id ? 'AND so.buyer_id = ?' : ''} ${q.order_type ? 'AND so.order_type = ?' : ''}
        ${q.order_status === 'open' ? 'AND COALESCE(s.is_terminal, 0) = 0' : q.order_status === 'closed' ? 'AND s.is_terminal = 1' : ''}`,
    [cid, ...(q.so_id ? [q.so_id] : []), ...(q.buyer_id ? [q.buyer_id] : []), ...(q.order_type ? [q.order_type] : [])]);
  return { ids: new Set(sos.map((s) => Number(s.id))), ios: new Set(sos.flatMap((s) => [s.io_no, s.so_no].filter(Boolean).map((x: string) => x.toUpperCase()))) };
}

async function stockLines(cid: number, q: StockQ) {
  const asOn = q.asOn ?? dstr(new Date())!;
  const so = await soFilter(cid, q);
  const groupOk = (g: string) => !q.item_group || q.item_group === g;
  const rows: any[] = [];
  // yarn / fabric / WIP / FG from the stock ledger (trims are kept in trx_trim_stock, see below)
  if (!q.item_group || q.item_group !== 'TRIM') {
    const led = await query<any>(
      `SELECT l.material_type, l.ref_type, l.ref_id, l.warehouse_id, l.bin_id, l.so_id, l.yarn_id, l.fabric_id, l.sku_id, l.color_id, l.uom_id,
              SUM(l.qty_in) plus_qty, SUM(l.qty_out) minus_qty, MIN(l.txn_date) txn_date,
              SUM(l.qty_in * l.rate) in_val, SUM(CASE WHEN l.rate > 0 THEN l.qty_in ELSE 0 END) rated_in
         FROM trx_stock_ledger l LEFT JOIN mst_warehouse w ON w.id = l.warehouse_id
        WHERE l.company_id = ? AND l.material_type <> 'TRIM' AND DATE(l.txn_date) <= ?
          ${q.warehouse_id ? 'AND l.warehouse_id = ?' : ''} ${q.unit_id ? 'AND w.unit_id = ?' : ''} ${q.item_group ? 'AND l.material_type = ?' : ''}
        GROUP BY l.material_type, l.ref_type, l.ref_id, l.warehouse_id, l.bin_id, l.so_id, l.yarn_id, l.fabric_id, l.sku_id, l.color_id, l.uom_id`,
      [cid, asOn, ...(q.warehouse_id ? [q.warehouse_id] : []), ...(q.unit_id ? [q.unit_id] : []), ...(q.item_group ? [q.item_group] : [])]);
    // weighted average in-rate per item (falls back to the master std rate)
    const avg = await query<any>(
      `SELECT material_type, COALESCE(yarn_id, 0) y, COALESCE(fabric_id, 0) f, COALESCE(sku_id, 0) s, SUM(qty_in * rate) / NULLIF(SUM(CASE WHEN rate > 0 THEN qty_in ELSE 0 END), 0) r
         FROM trx_stock_ledger WHERE company_id = ? AND DATE(txn_date) <= ? GROUP BY 1, 2, 3, 4`, [cid, asOn]);
    const avgOf = new Map(avg.map((a) => [`${a.material_type}:${a.y}:${a.f}:${a.s}`, n(a.r)]));
    rows.push(...led.filter((l) => !so || (l.so_id && so.ids.has(Number(l.so_id)))).map((l) => ({ ...l,
      rate: avgOf.get(`${l.material_type}:${l.yarn_id ?? 0}:${l.fabric_id ?? 0}:${l.sku_id ?? 0}`) ?? 0 })));
  }
  const refs = new Map<string, Set<number>>();
  for (const l of rows) if (l.ref_id) refs.set(l.ref_type, (refs.get(l.ref_type) ?? new Set()).add(Number(l.ref_id)));
  const refNo = new Map<string, { no: string; party?: string | null; process?: string | null; link?: string | null }>();
  const resolve = async (type: string, sql: string, link: (r: any) => string | null) => {
    const ids = [...(refs.get(type) ?? [])]; if (!ids.length) return;
    for (const r of await safe<any>(sql, [ids])) refNo.set(`${type}:${r.id}`, { no: r.no, party: r.party ?? null, process: r.process ?? null, link: link(r) });
  };
  await resolve('GRN', `SELECT g.id, g.grn_no no, p.party_name party, (SELECT MAX(material_type) FROM trx_grn_line WHERE grn_id = g.id) mat FROM trx_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id WHERE g.id IN (?)`,
    (r) => grnLink(String(r.mat ?? ''), Number(r.id)));
  await resolve('PROCESS_ISSUE', `SELECT i.id, COALESCE(i.dc_no, i.issue_no) no, p.party_name party, i.src_type process FROM trx_process_issue i LEFT JOIN mst_party p ON p.id = i.vendor_id WHERE i.id IN (?)`, () => '/production/knitting-programs');
  await resolve('PROCESS_RECEIPT', `SELECT r.id, r.receipt_no no, r.src_type process FROM trx_process_receipt r WHERE r.id IN (?)`, () => '/production/knitting-programs');
  await resolve('MATERIAL_ISSUE', `SELECT id, issue_no no FROM trx_material_issue WHERE id IN (?)`, () => '/inventory/issues');
  await resolve('FAB_DC', `SELECT id, issue_no no, 'CUTTING' process FROM trx_fabric_issue WHERE id IN (?)`, () => '/production/fabric-issues');
  await resolve('FAB_RETURN', `SELECT id, return_no no FROM trx_fabric_return WHERE id IN (?)`, () => '/inventory/ledger');
  await resolve('JW_FABRIC_DC', `SELECT jc.id, jc.challan_no no, p.party_name party, 'JOB WORK' process FROM trx_jobwork_challan jc LEFT JOIN mst_party p ON p.id = jc.vendor_id WHERE jc.id IN (?)`,
    (r) => `/production/jobwork-challans?dc=${r.id}`);
  const names = async (sql: string, ids: number[]) => new Map((ids.length ? await safe<any>(sql, [ids]) : []).map((r) => [Number(r.id), r]));
  const uniq = (k: string) => [...new Set(rows.map((r) => Number(r[k])).filter(Boolean))];
  const [yarn, fab, sku, col, wh, bin, sos, uom] = await Promise.all([
    names('SELECT id, yarn_name name FROM mst_yarn WHERE id IN (?)', uniq('yarn_id')),
    names('SELECT id, fabric_name name FROM mst_fabric WHERE id IN (?)', uniq('fabric_id')),
    names('SELECT k.id, CONCAT(s.style_code, " ", k.sku_code) name, s.style_code FROM mst_style_sku k LEFT JOIN mst_style s ON s.id = k.style_id WHERE k.id IN (?)', uniq('sku_id')),
    names('SELECT id, color_name name FROM mst_color WHERE id IN (?)', uniq('color_id')),
    names('SELECT w.id, w.warehouse_name name, u.unit_name FROM mst_warehouse w LEFT JOIN mst_unit u ON u.id = w.unit_id WHERE w.id IN (?)', uniq('warehouse_id')),
    names('SELECT id, bin_code name FROM mst_warehouse_bin WHERE id IN (?)', uniq('bin_id')),
    names('SELECT so.id, COALESCE(NULLIF(so.io_no, ""), so.so_no) name, st.style_code, b.party_name buyer FROM trx_sales_order so LEFT JOIN trx_sales_order_line sl ON sl.id = (SELECT MIN(id) FROM trx_sales_order_line WHERE so_id = so.id) LEFT JOIN mst_style st ON st.id = sl.style_id LEFT JOIN mst_party b ON b.id = so.buyer_id WHERE so.id IN (?)', uniq('so_id')),
    names('SELECT id, code name FROM cfg_uom WHERE id IN (?)', uniq('uom_id')),
  ]);
  const out = rows.map((l) => {
    const ref = refNo.get(`${l.ref_type}:${l.ref_id}`);
    const stock = r3(n(l.plus_qty) - n(l.minus_qty));
    const item = l.yarn_id ? yarn.get(Number(l.yarn_id))?.name : l.fabric_id ? fab.get(Number(l.fabric_id))?.name : l.sku_id ? sku.get(Number(l.sku_id))?.name : null;
    const w = wh.get(Number(l.warehouse_id)); const s = sos.get(Number(l.so_id));
    return { bucket: 'STOCK', item_group: l.material_type, unit: w?.unit_name ?? null, location: w?.name ?? null, so_no: s?.name ?? null, so_id: l.so_id ?? null,
      design_no: s?.style_code ?? (l.sku_id ? sku.get(Number(l.sku_id))?.style_code : null) ?? null,
      trans_no: ref?.no ?? (l.ref_type === 'OPENING' ? 'Opening stock' : `${l.ref_type ?? ''} #${l.ref_id ?? ''}`), trans_type: l.ref_type, trans_date: dstr(l.txn_date),
      party: ref?.party ?? null, process: ref?.process ?? null, item: item ?? `${l.material_type} #${l.yarn_id ?? l.fabric_id ?? l.sku_id ?? ''}`, color: col.get(Number(l.color_id))?.name ?? null,
      uom: uom.get(Number(l.uom_id))?.name ?? null, plus_qty: r3(n(l.plus_qty)), minus_qty: r3(n(l.minus_qty)), stock_qty: stock, rate: r2(n(l.rate)), amount: r2(stock * n(l.rate)),
      stock_age: daysBetween(l.txn_date, asOn), bin: bin.get(Number(l.bin_id))?.name ?? null, doc_link: ref?.link ?? '/inventory/ledger' };
  });
  // trims: current stock by lot (trx_trim_stock has no dated movements, so it is the as-of-today balance)
  if (groupOk('TRIM')) {
    const ts = await safe<any>(
      `SELECT ts.id, ts.trim_id, t.trim_name, COALESCE(t.std_rate, 0) std_rate, ts.color_name, ts.trim_size, ts.internal_lot_no, ts.bin_location, ts.stock_qty, ts.updated_at,
              w.warehouse_name, un.unit_name, u.code uom, ts.so_id, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code,
              (SELECT MAX(l.rate) FROM trx_trim_grn_line l JOIN trx_trim_grn g ON g.id = l.grn_id WHERE l.trim_id = ts.trim_id AND l.internal_lot_no = ts.internal_lot_no) grn_rate,
              (SELECT g.id FROM trx_trim_grn_line l JOIN trx_trim_grn g ON g.id = l.grn_id WHERE l.trim_id = ts.trim_id AND l.internal_lot_no = ts.internal_lot_no ORDER BY g.id LIMIT 1) grn_id,
              (SELECT CONCAT(g.grn_no, '|', g.grn_date, '|', COALESCE(p.party_name, '')) FROM trx_trim_grn_line l JOIN trx_trim_grn g ON g.id = l.grn_id LEFT JOIN mst_party p ON p.id = g.supplier_id
                WHERE l.trim_id = ts.trim_id AND l.internal_lot_no = ts.internal_lot_no ORDER BY g.id LIMIT 1) grn_info
         FROM trx_trim_stock ts LEFT JOIN mst_trim t ON t.id = ts.trim_id LEFT JOIN mst_warehouse w ON w.id = ts.warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
         LEFT JOIN cfg_uom u ON u.id = ts.uom_id LEFT JOIN trx_sales_order so ON so.id = ts.so_id LEFT JOIN mst_style st ON st.id = ts.style_id
        WHERE ts.company_id = ? AND ts.stock_qty <> 0 ${q.warehouse_id ? 'AND ts.warehouse_id = ?' : ''} ${q.unit_id ? 'AND w.unit_id = ?' : ''}`,
      [cid, ...(q.warehouse_id ? [q.warehouse_id] : []), ...(q.unit_id ? [q.unit_id] : [])]);
    for (const t of ts) {
      if (so && !(t.so_id && so.ids.has(Number(t.so_id)))) continue;
      const [gno, gdate, gparty] = String(t.grn_info ?? '||').split('|');
      const rate = n(t.grn_rate) || n(t.std_rate); const qty = r3(n(t.stock_qty));
      out.push({ bucket: 'STOCK', item_group: 'TRIM', unit: t.unit_name, location: t.warehouse_name, so_no: t.so_no, so_id: t.so_id, design_no: t.style_code,
        trans_no: gno || `Lot ${t.internal_lot_no ?? ''}`, trans_type: 'TRIM_GRN', trans_date: gdate || dstr(t.updated_at), party: gparty || null, process: null,
        item: [t.trim_name, t.trim_size].filter(Boolean).join(' · '), color: t.color_name, uom: t.uom, plus_qty: qty, minus_qty: 0, stock_qty: qty, rate: r2(rate), amount: r2(qty * rate),
        stock_age: daysBetween(gdate || t.updated_at, asOn), bin: t.bin_location, doc_link: t.grn_id ? `/procurement/trim/grn/${t.grn_id}` : '/inventory/stock' });
    }
  }
  return out;
}

async function transitLines(cid: number, q: StockQ) {
  const asOn = q.asOn ?? dstr(new Date())!;
  const so = await soFilter(cid, q);
  const out: any[] = [];
  // inter-store / unit transfers still in transit
  for (const t of await safe<any>(
    `SELECT t.id, t.transfer_no, t.transfer_date, t.transfer_type, fw.warehouse_name from_loc, tw.warehouse_name to_loc, l.material_type, l.qty,
            COALESCE(y.yarn_name, f.fabric_name, tr.trim_name, k.sku_code) item, c.color_name, u.code uom, COALESCE(y.std_rate, f.std_rate, tr.std_rate, 0) rate
       FROM trx_stock_transfer t JOIN trx_stock_transfer_line l ON l.transfer_id = t.id LEFT JOIN mst_warehouse fw ON fw.id = t.from_warehouse LEFT JOIN mst_warehouse tw ON tw.id = t.to_warehouse
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN mst_fabric f ON f.id = l.fabric_id LEFT JOIN mst_trim tr ON tr.id = l.trim_id LEFT JOIN mst_style_sku k ON k.id = l.sku_id
       LEFT JOIN mst_color c ON c.id = l.color_id LEFT JOIN cfg_uom u ON u.id = l.uom_id
      WHERE t.company_id = ? AND t.status = 'IN_TRANSIT' AND t.transfer_date <= ? ${q.warehouse_id ? 'AND (t.from_warehouse = ? OR t.to_warehouse = ?)' : ''}`,
    [cid, asOn, ...(q.warehouse_id ? [q.warehouse_id, q.warehouse_id] : [])])) {
    if (q.item_group && q.item_group !== t.material_type) continue;
    if (so) continue; // transfers carry no sale order
    const bal = r3(n(t.qty));
    out.push({ bucket: 'TRANSIT', type: `Stock transfer (${String(t.transfer_type ?? '').replace(/_/g, ' ').toLowerCase()})`, item_group: t.material_type, doc_no: t.transfer_no, doc_date: dstr(t.transfer_date),
      from_location: t.from_loc, to_location: t.to_loc, so_no: null, style_no: null, item: t.item, color: t.color_name, uom: t.uom, dc_qty: bal, grn_qty: 0, bal_qty: bal,
      rate: r2(n(t.rate)), amount: r2(bal * n(t.rate)), buyer: null, age: daysBetween(t.transfer_date, asOn), doc_link: '/inventory/transfers' });
  }
  // process DCs to our own in-house units (no outside party) — material between our locations
  if (!q.item_group || q.item_group === 'WIP') {
    for (const r of await safe<any>(
      `SELECT jc.id, jc.challan_no, jc.challan_date, jc.io_no, fw.warehouse_name from_loc, un.unit_name to_loc, st.style_code, b.party_name buyer, jc.rate, ps.stage_name,
              SUM(l.qty) dc_qty, SUM(COALESCE(l.received_qty, 0) + COALESCE(l.rejected_qty, 0) + COALESCE(l.shortage_qty, 0) + COALESCE(l.loss_qty, 0) + COALESCE(l.returned_qty, 0)) back_qty
         FROM trx_jobwork_challan jc JOIN trx_jobwork_challan_line l ON l.challan_id = jc.id LEFT JOIN mst_warehouse fw ON fw.id = jc.from_warehouse_id
         LEFT JOIN mst_unit un ON un.id = jc.unit_id LEFT JOIN mst_style st ON st.id = jc.style_id LEFT JOIN trx_sales_order so ON so.company_id = jc.company_id AND so.io_no = jc.io_no
         LEFT JOIN mst_party b ON b.id = so.buyer_id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
        WHERE jc.company_id = ? AND jc.vendor_id IS NULL AND jc.unit_id IS NOT NULL AND jc.status IN ('ISSUED', 'PARTIAL_RECEIVED') AND jc.challan_date <= ?
        GROUP BY jc.id`, [cid, asOn])) {
      if (so && !(r.io_no && so.ios.has(String(r.io_no).toUpperCase()))) continue;
      const bal = r3(Math.max(0, n(r.dc_qty) - n(r.back_qty)));
      if (bal <= 0) continue;
      out.push({ bucket: 'TRANSIT', type: `In-house unit DC${r.stage_name ? ` — ${r.stage_name}` : ''}`, item_group: 'WIP', doc_no: r.challan_no, doc_date: dstr(r.challan_date), from_location: r.from_loc,
        to_location: r.to_loc, so_no: r.io_no, style_no: r.style_code, item: 'Cut panels / garments', color: null, uom: 'PCS', dc_qty: r3(n(r.dc_qty)), grn_qty: r3(n(r.back_qty)), bal_qty: bal,
        rate: r2(n(r.rate)), amount: r2(bal * n(r.rate)), buyer: r.buyer, age: daysBetween(r.challan_date, asOn), doc_link: `/production/jobwork-challans?dc=${r.id}` });
    }
  }
  return out;
}

async function outstandingLines(cid: number, q: StockQ) {
  const asOn = q.asOn ?? dstr(new Date())!;
  const so = await soFilter(cid, q);
  const ioOk = (io: unknown) => !so || (io && String(io).split(',').some((x) => so.ios.has(x.trim().toUpperCase())));
  const out: any[] = [];
  const add = (o: any) => { if (o.bal_qty > 0.0005 && ioOk(o.so_no) && (!q.item_group || q.item_group === o.item_group)) out.push(o); };
  // fabric process DCs at the processor
  for (const r of await safe<any>(
    `SELECT o.id, o.fpo_no, o.fpo_date, o.io_no, o.sub_process, o.input_weight_kg, COALESCE(f.std_rate, 0) rate, f.fabric_name, o.color_name, v.party_name, st.style_code,
            w.warehouse_name, un.unit_name,
            (SELECT COALESCE(SUM(i.input_kg), 0) FROM trx_fabric_process_inward i WHERE i.fpo_id = o.id AND i.status = 'POSTED' AND i.inward_date <= ?) back_kg,
            (SELECT COALESCE(SUM(i.loss_kg), 0) FROM trx_fabric_process_inward i WHERE i.fpo_id = o.id AND i.status = 'POSTED' AND i.inward_date <= ?) loss_kg
       FROM trx_fabric_process_order o LEFT JOIN mst_fabric f ON f.id = o.fabric_id LEFT JOIN mst_party v ON v.id = o.vendor_id LEFT JOIN mst_style st ON st.id = o.style_id
       LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT', 'CANCELLED', 'CLOSED', 'COMPLETED') AND o.fpo_date <= ?`, [asOn, asOn, cid, asOn])) {
    const iss = n(r.input_weight_kg); const bal = r3(Math.max(0, iss - n(r.back_kg)));
    add({ bucket: 'OUTSTANDING', type: 'Fabric process DC', item_group: 'FABRIC', doc_no: r.fpo_no, doc_date: dstr(r.fpo_date), party: r.party_name, process: r.sub_process, so_no: r.io_no,
      style_no: r.style_code, item: r.fabric_name, color: r.color_name, uom: 'KG', issue_qty: r3(iss), grn_qty: r3(n(r.back_kg)), bal_qty: bal, rate: r2(n(r.rate)), amount: r2(bal * n(r.rate)),
      location: r.warehouse_name, unit: r.unit_name, loss_pct: iss ? r2((n(r.loss_kg) / iss) * 100) : 0, age: daysBetween(r.fpo_date, asOn), doc_link: `/production/fabric-process/outward?id=${r.id}` });
  }
  // yarn process DCs at the processor
  for (const r of await safe<any>(
    `SELECT o.id, o.ypo_no, o.ypo_date, o.process_code, o.total_kg, v.party_name, w.warehouse_name, un.unit_name,
            (SELECT GROUP_CONCAT(DISTINCT l.io_no) FROM trx_yarn_process_order_line l WHERE l.ypo_id = o.id) io_no,
            (SELECT MAX(y.yarn_name) FROM trx_yarn_process_order_line l JOIN mst_yarn y ON y.id = l.yarn_id WHERE l.ypo_id = o.id) yarn_name,
            (SELECT MAX(y.std_rate) FROM trx_yarn_process_order_line l JOIN mst_yarn y ON y.id = l.yarn_id WHERE l.ypo_id = o.id) rate,
            (SELECT COALESCE(SUM(i.input_kg), 0) FROM trx_yarn_process_inward i WHERE i.ypo_id = o.id AND i.status = 'POSTED' AND i.inward_date <= ?) back_kg,
            (SELECT COALESCE(SUM(i.loss_kg), 0) FROM trx_yarn_process_inward i WHERE i.ypo_id = o.id AND i.status = 'POSTED' AND i.inward_date <= ?) loss_kg
       FROM trx_yarn_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id LEFT JOIN mst_unit un ON un.id = w.unit_id
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT', 'CANCELLED', 'CLOSED', 'COMPLETED') AND o.ypo_date <= ?`, [asOn, asOn, cid, asOn])) {
    const iss = n(r.total_kg); const bal = r3(Math.max(0, iss - n(r.back_kg)));
    add({ bucket: 'OUTSTANDING', type: 'Yarn process DC', item_group: 'YARN', doc_no: r.ypo_no, doc_date: dstr(r.ypo_date), party: r.party_name, process: r.process_code, so_no: r.io_no, style_no: null,
      item: r.yarn_name, color: null, uom: 'KG', issue_qty: r3(iss), grn_qty: r3(n(r.back_kg)), bal_qty: bal, rate: r2(n(r.rate)), amount: r2(bal * n(r.rate)), location: r.warehouse_name,
      unit: r.unit_name, loss_pct: iss ? r2((n(r.loss_kg) / iss) * 100) : 0, age: daysBetween(r.ypo_date, asOn), doc_link: `/production/yarn-process/outward?id=${r.id}` });
  }
  // knitting DCs (yarn at the knitter): issued yarn vs yarn consumed on knitting GRNs + yarn returned
  for (const r of await safe<any>(
    `SELECT i.dc_no, MIN(i.issue_date) dc_date, MAX(v.party_name) party_name, SUM(i.issued_qty_kg) iss, GROUP_CONCAT(DISTINCT i.io_no) io_no, MAX(y.yarn_name) yarn_name,
            MAX(COALESCE(y.std_rate, 0)) rate, MAX(w.warehouse_name) warehouse_name, MAX(un.unit_name) unit_name, MAX(kd.status) kd_status,
            (SELECT COALESCE(SUM(m.consumed_kg), 0) FROM trx_knitting_inward_dc m JOIN trx_process_receipt pr ON pr.id = m.receipt_id WHERE m.dc_no = i.dc_no AND pr.company_id = i.company_id AND pr.receipt_date <= ?) used_kg
       FROM trx_process_issue i LEFT JOIN mst_party v ON v.id = i.vendor_id LEFT JOIN mst_yarn y ON y.id = i.yarn_id LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
       LEFT JOIN mst_unit un ON un.id = w.unit_id LEFT JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
      WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL AND i.issue_date <= ? GROUP BY i.dc_no`, [asOn, cid, asOn])) {
    if (String(r.kd_status ?? '').toUpperCase() === 'CLOSED') continue;
    const iss = n(r.iss); const bal = r3(Math.max(0, iss - n(r.used_kg)));
    add({ bucket: 'OUTSTANDING', type: 'Knitting DC (yarn)', item_group: 'YARN', doc_no: r.dc_no, doc_date: dstr(r.dc_date), party: r.party_name, process: 'KNITTING', so_no: r.io_no, style_no: null,
      item: r.yarn_name, color: null, uom: 'KG', issue_qty: r3(iss), grn_qty: r3(n(r.used_kg)), bal_qty: bal, rate: r2(n(r.rate)), amount: r2(bal * n(r.rate)), location: r.warehouse_name,
      unit: r.unit_name, loss_pct: 0, age: daysBetween(r.dc_date, asOn), doc_link: '/production/knitting-programs' });
  }
  // garment process / job-work DCs at outside parties
  if (!q.item_group || q.item_group === 'WIP') {
    for (const r of await safe<any>(
      `SELECT jc.id, jc.challan_no, jc.challan_date, jc.io_no, jc.rate, v.party_name, ps.stage_name, st.style_code, fw.warehouse_name, un.unit_name,
              SUM(l.qty) iss, SUM(COALESCE(l.received_qty, 0) + COALESCE(l.rejected_qty, 0) + COALESCE(l.returned_qty, 0)) back_qty, SUM(COALESCE(l.loss_qty, 0) + COALESCE(l.shortage_qty, 0)) loss_qty
         FROM trx_jobwork_challan jc JOIN trx_jobwork_challan_line l ON l.challan_id = jc.id LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
         LEFT JOIN mst_style st ON st.id = jc.style_id LEFT JOIN mst_warehouse fw ON fw.id = jc.from_warehouse_id LEFT JOIN mst_unit un ON un.id = fw.unit_id
        WHERE jc.company_id = ? AND jc.vendor_id IS NOT NULL AND jc.status IN ('ISSUED', 'PARTIAL_RECEIVED') AND jc.challan_date <= ? GROUP BY jc.id`, [cid, asOn])) {
      const iss = n(r.iss); const bal = r3(Math.max(0, iss - n(r.back_qty) - n(r.loss_qty)));
      add({ bucket: 'OUTSTANDING', type: 'Process DC (garment)', item_group: 'WIP', doc_no: r.challan_no, doc_date: dstr(r.challan_date), party: r.party_name, process: r.stage_name, so_no: r.io_no,
        style_no: r.style_code, item: 'Cut panels / garments', color: null, uom: 'PCS', issue_qty: r3(iss), grn_qty: r3(n(r.back_qty)), bal_qty: bal, rate: r2(n(r.rate)), amount: r2(bal * n(r.rate)),
        location: r.warehouse_name, unit: r.unit_name, loss_pct: iss ? r2((n(r.loss_qty) / iss) * 100) : 0, age: daysBetween(r.challan_date, asOn), doc_link: `/production/jobwork-challans?dc=${r.id}` });
    }
  }
  return out;
}

async function jobOrderLines(cid: number, q: StockQ) {
  if (q.item_group && q.item_group !== 'JOB') return [];
  const asOn = q.asOn ?? dstr(new Date())!;
  const rows = await safe<any>(
    `SELECT j.id, j.jwin_no, j.jwin_date, j.customer_dc_no, j.process_type, j.rate, p.party_name, l.description, l.material_type, u.code uom,
            COALESCE(l.received_qty, l.qty, 0) rec_qty, COALESCE(l.returned_qty, 0) + COALESCE(l.rejected_qty, 0) out_qty
       FROM trx_jobwork_in j JOIN trx_jobwork_in_line l ON l.jwin_id = j.id LEFT JOIN mst_party p ON p.id = j.customer_id LEFT JOIN cfg_uom u ON u.id = l.uom_id
      WHERE j.company_id = ? AND j.status NOT IN ('DRAFT', 'DISPATCHED', 'INVOICED', 'CLOSED') AND j.jwin_date <= ?`, [cid, asOn]);
  return rows.map((r) => {
    const bal = r3(Math.max(0, n(r.rec_qty) - n(r.out_qty)));
    return { bucket: 'JOB_ORDER', type: 'Job-work-in (customer material)', item_group: 'JOB', doc_no: r.jwin_no, doc_date: dstr(r.jwin_date), party: r.party_name, process: r.process_type,
      so_no: r.customer_dc_no, item: r.description ?? r.material_type, uom: r.uom ?? 'PCS', plus_qty: r3(n(r.rec_qty)), minus_qty: r3(n(r.out_qty)), stock_qty: bal, rate: r2(n(r.rate)),
      amount: r2(bal * n(r.rate)), age: daysBetween(r.jwin_date, asOn), doc_link: '/production/jobwork-ins' };
  }).filter((r) => r.stock_qty > 0);
}

const STOCK_NOTES = [
  'STOCK: yarn / fabric / WIP / FG from the stock ledger up to the as-on date (rate = weighted average GRN rate); trims from trims stock by lot (current balance, valued at the GRN rate or master rate).',
  'TRANSIT: stock transfers still in transit + open process DCs to our own in-house units (DC qty vs received back).',
  'OUTSTANDING: material at outside parties on open DCs — fabric process, yarn process, knitting (yarn issued vs consumed on knitting GRNs) and garment process DCs. Fabric / yarn valued at master std rate; garment DCs at the DC process rate.',
  'JOB ORDER STOCK: customer material received on open job-work-in orders, valued at the job-work rate.',
];

clientReportsBRouter.get('/b/stock-statement', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = stockQ.parse(req.query);
  const [st, tr, os, jo] = await Promise.all([stockLines(cid, q), transitLines(cid, q), outstandingLines(cid, q), jobOrderLines(cid, q)]);
  const sum = (rows: any[], qk: string) => ({ qty: r3(rows.reduce((a, r) => a + n(r[qk]), 0)), amount: r2(rows.reduce((a, r) => a + n(r.amount), 0)), lines: rows.length });
  const data: any[] = [];
  const groups = (rows: any[], key: string) => [...new Set(rows.map((r) => r[key]))].sort();
  for (const g of groups(st, 'item_group')) data.push({ stock_type: 'STOCK', group: g, ...sum(st.filter((r) => r.item_group === g), 'stock_qty'), bucket: `STOCK:${g}` });
  data.push({ stock_type: 'STOCK', group: 'Total', ...sum(st, 'stock_qty'), bucket: 'STOCK', is_total: 1 });
  for (const g of groups(tr, 'type')) data.push({ stock_type: 'TRANSIT STOCK', group: g, ...sum(tr.filter((r) => r.type === g), 'bal_qty'), bucket: `TRANSIT:${g}` });
  data.push({ stock_type: 'TRANSIT STOCK', group: 'Total', ...sum(tr, 'bal_qty'), bucket: 'TRANSIT', is_total: 1 });
  for (const g of groups(os, 'type')) data.push({ stock_type: 'OUTSTANDING', group: g, ...sum(os.filter((r) => r.type === g), 'bal_qty'), bucket: `OUTSTANDING:${g}` });
  data.push({ stock_type: 'OUTSTANDING', group: 'Total', ...sum(os, 'bal_qty'), bucket: 'OUTSTANDING', is_total: 1 });
  data.push({ stock_type: 'JOB ORDER STOCK', group: 'Total', ...sum(jo, 'stock_qty'), bucket: 'JOB_ORDER', is_total: 1 });
  const grand = { qty: 0, amount: 0, lines: 0 };
  for (const r of data.filter((x) => x.is_total)) { grand.qty += r.qty; grand.amount += r.amount; grand.lines += r.lines; }
  data.push({ stock_type: 'GRAND TOTAL', group: '', qty: r3(grand.qty), amount: r2(grand.amount), lines: grand.lines, bucket: '', is_total: 1 });
  res.json({ data, meta: { as_on: q.asOn ?? dstr(new Date()), footnotes: [...STOCK_NOTES, 'Quantities mix units (KG, PCS, MTR…) — read qty within a group; amounts are comparable across groups.'] } });
}));

clientReportsBRouter.get('/b/stock-statement/lines', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = stockQ.parse(req.query);
  const [bucket, group] = String(q.bucket ?? 'STOCK').split(/:(.*)/s);
  let data: any[] = [];
  if (bucket === 'STOCK') data = (await stockLines(cid, q)).filter((r) => !group || r.item_group === group).filter((r) => Math.abs(r.plus_qty) + Math.abs(r.minus_qty) > 0);
  else if (bucket === 'TRANSIT') data = (await transitLines(cid, q)).filter((r) => !group || r.type === group);
  else if (bucket === 'OUTSTANDING') data = (await outstandingLines(cid, q)).filter((r) => !group || r.type === group);
  else if (bucket === 'JOB_ORDER') data = await jobOrderLines(cid, q);
  res.json({ data, meta: { bucket, group: group ?? null, footnotes: STOCK_NOTES } });
}));

// =====================================================================================
// 6. Bill tracker (entry screen is built by the stores-transactions agent: trx_bill_tracker)
// =====================================================================================
clientReportsBRouter.get('/b/bill-tracker', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ status: STATUS, dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(req.query);
  if (!(await tableExists('trx_bill_tracker'))) {
    return res.json({ data: [], meta: { footnotes: ['Bill tracker entries are not available yet — the Bill Tracker entry screen (table trx_bill_tracker) has not been set up in this database.'] } });
  }
  const cols = new Set((await query<any>(`SELECT column_name c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'trx_bill_tracker'`)).map((r) => String(r.c ?? r.COLUMN_NAME).toLowerCase()));
  const pick = (...cands: string[]) => cands.find((c) => cols.has(c));
  const col = (alias: string, ...cands: string[]) => { const c = pick(...cands); return c ? `bt.\`${c}\` AS ${alias}` : `NULL AS ${alias}`; };
  const partyCol = pick('supplier_id', 'party_id', 'vendor_id');
  const dateCol = pick('entry_date', 'tracker_date', 'doc_date', 'created_at');
  const userJoin = (alias: string, ...cands: string[]) => { const c = pick(...cands); return c ? `LEFT JOIN mst_user ${alias} ON ${alias}.id = bt.\`${c}\`` : ''; };
  const sql = `SELECT bt.id, ${col('entry_date', 'entry_date', 'tracker_date', 'doc_date', 'created_at')}, ${col('tracker_no', 'tracker_no', 'entry_no', 'doc_no')},
      ${col('bill_no', 'bill_no', 'party_bill_no', 'supplier_bill_no', 'supplier_inv_no')}, ${col('bill_date', 'bill_date', 'party_bill_date', 'supplier_inv_date')},
      ${partyCol ? 'p.party_name AS supplier' : col('supplier', 'supplier_name', 'party_name')}, ${col('purchase_process', 'purchase_or_process', 'purchase_process_name', 'process_name', 'bill_type', 'purpose')},
      ${col('amount', 'amount', 'bill_amount', 'net_amount', 'total_amount')},
      ${pick('handed_over_to_user_id', 'handed_to_user_id', 'handed_over_user_id') ? 'hu.full_name' : pick('handed_over_to', 'handed_to', 'handover_to') ? `bt.\`${pick('handed_over_to', 'handed_to', 'handover_to')}\`` : 'NULL'} AS handed_over_to,
      ${col('department', 'handover_department', 'hand_over_department', 'department', 'department_name')}, ${col('handover_date', 'handover_date', 'hand_over_date', 'handed_over_date', 'handed_on')},
      ${col('received_back_date', 'received_back_date', 'returned_date', 'received_back_on')}, ${col('submitted_to_accounts_on', 'submitted_to_accounts_on', 'accounts_submitted_date', 'submitted_on', 'accounts_date')},
      ${pick('accounts_user_id', 'ac_recipient_user_id', 'received_by_user_id') ? 'au.full_name' : pick('ac_recipient_name', 'accounts_recipient', 'ac_recipient', 'received_by_name') ? `bt.\`${pick('ac_recipient_name', 'accounts_recipient', 'ac_recipient', 'received_by_name')}\`` : 'NULL'} AS ac_recipient,
      ${col('status', 'status')}, ${col('received_from', 'received_from')}, ${col('received_from_dept', 'received_from_dept')}, ${col('ref_type', 'ref_type', 'source_type', 'bill_source')}, ${col('ref_id', 'ref_id', 'source_id', 'bill_id')}
    FROM trx_bill_tracker bt ${partyCol ? `LEFT JOIN mst_party p ON p.id = bt.\`${partyCol}\`` : ''}
      ${userJoin('hu', 'handed_over_to_user_id', 'handed_to_user_id', 'handed_over_user_id')} ${userJoin('au', 'accounts_user_id', 'ac_recipient_user_id', 'received_by_user_id')}
    WHERE ${cols.has('company_id') ? 'bt.company_id = ?' : '1 = 1'} ${cols.has('is_deleted') ? 'AND bt.is_deleted = 0' : ''} ${cols.has('status') ? "AND COALESCE(bt.status, '') <> 'CANCELLED'" : ''}
    ORDER BY ${dateCol ? `bt.\`${dateCol}\`` : 'bt.id'}, bt.id`;
  const rows = await query<any>(sql, cols.has('company_id') ? [cid] : []);
  let data = rows.map((r, i) => {
    const submitted = !!r.submitted_to_accounts_on || r.status === 'SUBMITTED';
    return { sno: i + 1, ...r, entry_date: dstr(r.entry_date), bill_date: dstr(r.bill_date), handover_date: dstr(r.handover_date), received_back_date: dstr(r.received_back_date),
      submitted_to_accounts_on: dstr(r.submitted_to_accounts_on), amount: r2(n(r.amount)), age: daysBetween(r.entry_date, submitted ? r.submitted_to_accounts_on : undefined),
      state: submitted ? 'DONE' : 'PENDING', doc_link: `/stores/bill-tracker?id=${r.id}` };
  });
  if (q.status !== 'all') data = data.filter((r) => r.state === (q.status === 'done' ? 'DONE' : 'PENDING'));
  if (q.dateFrom || q.dateTo) data = data.filter((r) => inRange(r.entry_date, q.dateFrom, q.dateTo));
  res.json({ data, meta: { footnotes: ['Done = bill submitted to accounts. Age = tracker entry date → submitted to accounts (or today).'] } });
}));

// =====================================================================================
// 7. User rights + userwise log
// =====================================================================================
clientReportsBRouter.get('/b/user-rights', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ user_id: optId, active: z.enum(['all', 'active', 'inactive']).default('active') }).parse(req.query);
  const users = await query<any>(
    `SELECT u.id, u.username, u.full_name, u.employee_code, u.email, u.mobile, u.is_active, u.is_locked, u.last_login_at, db.branch_name default_location,
            (SELECT GROUP_CONCAT(DISTINCT b.branch_name ORDER BY b.branch_name SEPARATOR ', ') FROM map_user_branch ub JOIN mst_branch b ON b.id = ub.branch_id WHERE ub.user_id = u.id) locations,
            (SELECT GROUP_CONCAT(DISTINCT r.role_name ORDER BY r.role_name SEPARATOR ', ') FROM map_user_role ur JOIN mst_role r ON r.id = ur.role_id WHERE ur.user_id = u.id) roles,
            (SELECT MAX(r.role_code = 'SUPER_ADMIN') FROM map_user_role ur JOIN mst_role r ON r.id = ur.role_id WHERE ur.user_id = u.id) is_super,
            (SELECT COUNT(DISTINCT rp.permission_id) FROM map_user_role ur JOIN map_role_permission rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id) perm_count
       FROM mst_user u LEFT JOIN mst_branch db ON db.id = u.default_branch
      WHERE u.company_id = ? AND u.is_deleted = 0 ${q.user_id ? 'AND u.id = ?' : ''}
        ${q.active === 'active' ? 'AND u.is_active = 1' : q.active === 'inactive' ? 'AND u.is_active = 0' : ''} ORDER BY u.full_name`, [cid, ...(q.user_id ? [q.user_id] : [])]);
  const perms = users.length ? await query<any>(
    `SELECT ur.user_id, COALESCE(m.module_name, 'General') module, GROUP_CONCAT(DISTINCT SUBSTRING_INDEX(p.permission_code, '.', -1) ORDER BY p.permission_code SEPARATOR ' / ') actions
       FROM map_user_role ur JOIN map_role_permission rp ON rp.role_id = ur.role_id JOIN mst_permission p ON p.id = rp.permission_id LEFT JOIN mst_module m ON m.id = p.module_id
      WHERE ur.user_id IN (?) GROUP BY ur.user_id, module ORDER BY module`, [users.map((u) => u.id)]) : [];
  const data = users.map((u) => ({
    user_id: u.id, username: u.username, full_name: u.full_name, employee_code: u.employee_code, roles: u.roles, locations: u.locations ?? u.default_location ?? 'All locations',
    default_location: u.default_location, perm_count: u.is_super ? 'ALL (super admin)' : Number(u.perm_count) || 0,
    rights: u.is_super ? 'Full access' : perms.filter((p) => Number(p.user_id) === Number(u.id)).map((p) => `${p.module}: ${p.actions}`).join('; '),
    active: u.is_active ? 'Yes' : 'No', locked: u.is_locked ? 'Yes' : 'No', last_login_at: u.last_login_at, user_link: '/admin/users', role_link: '/admin/roles' }));
  res.json({ data, meta: { footnotes: ['Rights come from the user\'s roles (role → permissions). Locations = branches mapped to the user; no mapping means the user is not restricted by location.'] } });
}));

clientReportsBRouter.get('/b/user-rights/detail', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ user_id: optId }).parse(req.query);
  const rows = await query<any>(
    `SELECT u.id user_id, u.username, u.full_name, r.role_name, COALESCE(m.module_name, 'General') module, p.permission_code, p.permission_name
       FROM mst_user u JOIN map_user_role ur ON ur.user_id = u.id JOIN mst_role r ON r.id = ur.role_id JOIN map_role_permission rp ON rp.role_id = r.id
       JOIN mst_permission p ON p.id = rp.permission_id LEFT JOIN mst_module m ON m.id = p.module_id
      WHERE u.company_id = ? AND u.is_deleted = 0 ${q.user_id ? 'AND u.id = ?' : ''} ORDER BY u.full_name, module, p.permission_code`, [cid, ...(q.user_id ? [q.user_id] : [])]);
  res.json({ data: rows.map((r) => ({ ...r, user_link: '/admin/users', role_link: '/admin/roles' })), meta: { footnotes: [] } });
}));

const AUDIT_DOC: Record<string, { col: string; link: (id: number) => string }> = {
  trx_grn: { col: 'grn_no', link: () => '/procurement/grns' },
  trx_trim_grn: { col: 'grn_no', link: (id) => `/procurement/trim/grn/${id}` },
  trx_purchase_order: { col: 'po_no', link: () => '/procurement/purchase-orders' },
  trx_trim_po: { col: 'po_no', link: (id) => `/procurement/trim/orders/${id}` },
  trx_general_purchase: { col: 'purchase_no', link: (id) => `/procurement/general-purchases/${id}` },
  trx_supplier_bill: { col: 'bill_no', link: () => '/procurement/supplier-bills' },
  trx_gate_inward: { col: 'entry_no', link: (id) => `/gate/inwards?id=${id}` },
  trx_gate_outward: { col: 'pass_no', link: (id) => `/gate/outwards?id=${id}` },
  trx_jobwork_challan: { col: 'challan_no', link: (id) => `/production/jobwork-challans?dc=${id}` },
  trx_jobwork_receipt: { col: 'receipt_no', link: (id) => `/production/jobwork-receipts?id=${id}` },
  trx_sales_order: { col: 'so_no', link: (id) => `/sales/orders/${id}` },
  trx_purchase_return: { col: 'return_no', link: (id) => `/procurement/returns/${id}` },
  trx_fabric_process_order: { col: 'fpo_no', link: (id) => `/production/fabric-process/outward?id=${id}` },
  trx_yarn_process_order: { col: 'ypo_no', link: (id) => `/production/yarn-process/outward?id=${id}` },
  trx_stock_transfer: { col: 'transfer_no', link: () => '/inventory/transfers' },
  trx_packing: { col: 'pack_no', link: () => '/logistics/packings' },
  trx_dispatch: { col: 'dispatch_no', link: () => '/logistics/dispatches' },
  mst_party: { col: 'party_name', link: (id) => `/masters/parties/${id}` },
  mst_user: { col: 'username', link: () => '/admin/users' },
  mst_style: { col: 'style_code', link: () => '/masters/styles' },
};

clientReportsBRouter.get('/b/user-log', requirePermission('AUDIT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const today = dstr(new Date())!;
  const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional(), user_id: optId, action: z.enum(['INSERT', 'UPDATE', 'DELETE']).optional(), table: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(2000) }).parse(req.query);
  const from = q.dateFrom ?? dstr(new Date(Date.now() - 30 * 86400000))!; const to = q.dateTo ?? today;
  const rows = await query<any>(
    `SELECT a.id, a.changed_at, a.action, a.table_name, a.record_id, a.ip_address, a.changed_by, u.username, u.full_name
       FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE a.company_id = ? AND a.changed_at >= ? AND a.changed_at < DATE_ADD(?, INTERVAL 1 DAY)
        ${q.user_id ? 'AND a.changed_by = ?' : ''} ${q.action ? 'AND a.action = ?' : ''} ${q.table ? 'AND a.table_name LIKE ?' : ''}
      ORDER BY a.changed_at DESC, a.id DESC LIMIT ${q.limit}`,
    [cid, from, to, ...(q.user_id ? [q.user_id] : []), ...(q.action ? [q.action] : []), ...(q.table ? [`%${q.table}%`] : [])]);
  // resolve the document number of each touched record, one query per table
  const docNo = new Map<string, string>();
  const byTable = new Map<string, Set<number>>();
  for (const r of rows) if (AUDIT_DOC[r.table_name] && r.record_id) byTable.set(r.table_name, (byTable.get(r.table_name) ?? new Set()).add(Number(r.record_id)));
  for (const [t, ids] of byTable) {
    for (const d of await safe<any>(`SELECT id, \`${AUDIT_DOC[t].col}\` no FROM \`${t}\` WHERE id IN (?)`, [[...ids]])) docNo.set(`${t}:${d.id}`, d.no);
  }
  const data = rows.map((r) => ({
    log_id: r.id, changed_at: r.changed_at, log_date: dstr(r.changed_at), user: [r.username, r.full_name].filter(Boolean).join(' / ') || (r.changed_by ? `#${r.changed_by}` : 'system'),
    user_id: r.changed_by, action: r.action, document_type: String(r.table_name).replace(/^(trx|mst|cfg|map)_/, '').replace(/_/g, ' '), table_name: r.table_name, record_id: r.record_id,
    document: docNo.get(`${r.table_name}:${r.record_id}`) ?? `#${r.record_id}`, ip_address: r.ip_address,
    doc_link: AUDIT_DOC[r.table_name] && r.action !== 'DELETE' ? AUDIT_DOC[r.table_name].link(Number(r.record_id)) : `/reports/audit?table=${r.table_name}&record=${r.record_id}` }));
  res.json({ data, meta: { footnotes: [`Audit trail ${from} → ${to}${rows.length >= q.limit ? ` (latest ${q.limit} entries — narrow the dates for more)` : ''}. Every create / edit / delete written by the ERP is logged.`] } });
}));

// =====================================================================================
// 8. Direct bills passed during a period
// =====================================================================================
clientReportsBRouter.get('/b/direct-bills', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const today = dstr(new Date())!;
  const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional(), party_id: optId }).parse(req.query);
  const from = q.dateFrom ?? `${today.slice(0, 4)}-01-01`; const to = q.dateTo ?? today;
  const sb = await query<any>(
    `SELECT b.id, b.bill_no, b.bill_date, b.bill_type, b.supplier_id, p.party_name, b.supplier_inv_no, b.supplier_inv_date, b.subtotal, b.gst_amount, b.total_amount, b.status, us.full_name prepared_by
       FROM trx_supplier_bill b LEFT JOIN mst_party p ON p.id = b.supplier_id LEFT JOIN mst_user us ON us.id = b.created_by
      WHERE b.company_id = ? AND b.status <> 'CANCELLED' AND b.bill_date BETWEEN ? AND ?
        AND b.po_id IS NULL AND b.grn_id IS NULL AND COALESCE(JSON_LENGTH(b.grn_ids), 0) = 0 AND COALESCE(JSON_LENGTH(b.trim_grn_ids), 0) = 0
        AND b.knitting_order_id IS NULL AND b.fabric_process_order_id IS NULL AND b.jobwork_order_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM trx_supplier_bill_line l WHERE l.bill_id = b.id AND (l.grn_id IS NOT NULL OR l.grn_line_id IS NOT NULL OR l.po_line_id IS NOT NULL))
        ${q.party_id ? 'AND b.supplier_id = ?' : ''}`, [cid, from, to, ...(q.party_id ? [q.party_id] : [])]);
  const gp = await safe<any>(
    `SELECT g.id, COALESCE(NULLIF(g.grn_no, ''), g.purchase_no) bill_no, g.purchase_date bill_date, g.purchase_type, g.supplier_id, p.party_name, g.supplier_inv_no, g.supplier_inv_date,
            g.subtotal, g.tax_amount, g.grand_total, g.approval_state, us.full_name prepared_by
       FROM trx_general_purchase g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_user us ON us.id = g.created_by
      WHERE g.company_id = ? AND g.doc_kind = 'GRN' AND g.is_deleted = 0 AND g.reference_po_id IS NULL AND COALESCE(g.supplier_inv_no, '') <> ''
        AND g.approval_state NOT IN ('CANCELLED', 'REJECTED', 'DRAFT') AND g.purchase_date BETWEEN ? AND ? ${q.party_id ? 'AND g.supplier_id = ?' : ''}`,
    [cid, from, to, ...(q.party_id ? [q.party_id] : [])]);
  const data = [
    ...sb.map((b) => ({ source: 'Supplier bill (no PO / GRN)', bill_type: b.bill_type, doc_no: b.bill_no, doc_date: dstr(b.bill_date), party: b.party_name, party_bill_no: b.supplier_inv_no,
      party_bill_date: dstr(b.supplier_inv_date), taxable: r2(n(b.subtotal)), gst: r2(n(b.gst_amount)), total: r2(n(b.total_amount)), status: b.status, prepared_by: b.prepared_by,
      doc_link: '/procurement/supplier-bills?tab=SUPPLIER' })),
    ...gp.map((g) => ({ source: 'Direct purchase (general, no PO)', bill_type: g.purchase_type, doc_no: g.bill_no, doc_date: dstr(g.bill_date), party: g.party_name, party_bill_no: g.supplier_inv_no,
      party_bill_date: dstr(g.supplier_inv_date), taxable: r2(n(g.subtotal)), gst: r2(n(g.tax_amount)), total: r2(n(g.grand_total)), status: g.approval_state, prepared_by: g.prepared_by,
      doc_link: `/procurement/general-purchases/${g.id}` })),
  ].sort((a, b) => String(a.doc_date).localeCompare(String(b.doc_date)));
  res.json({ data, meta: { footnotes: [`Bills passed ${from} → ${to} without a PO / GRN link: supplier bills with no PO, GRN or process order, and general purchases entered directly against a supplier invoice (no PO).`] } });
}));

// =====================================================================================
// 9. Opening stock register (stores; "Opening stock made during a period")
// =====================================================================================
clientReportsBRouter.get('/b/opening-stock', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional(), item_group: z.string().optional(), warehouse_id: optId }).parse(req.query);
  const rows = await query<any>(
    `SELECT l.id, l.txn_date, l.material_type, w.warehouse_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, so.season, so.order_type, b.party_name buyer, st.style_code,
            COALESCE(y.yarn_name, f.fabric_name, t.trim_name, k.sku_code) item, c.color_name, sz.size_label, u.code uom, l.qty_in, l.qty_out, l.rate, us.full_name prepared_by, l.ref_id
       FROM trx_stock_ledger l LEFT JOIN mst_warehouse w ON w.id = l.warehouse_id LEFT JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN mst_party b ON b.id = so.buyer_id
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN mst_fabric f ON f.id = l.fabric_id LEFT JOIN mst_trim t ON t.id = l.trim_id LEFT JOIN mst_style_sku k ON k.id = l.sku_id
       LEFT JOIN mst_style st ON st.id = k.style_id LEFT JOIN mst_size sz ON sz.id = k.size_id LEFT JOIN mst_color c ON c.id = l.color_id LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_user us ON us.id = l.created_by
      WHERE l.company_id = ? AND l.ref_type = 'OPENING' ${q.dateFrom ? 'AND DATE(l.txn_date) >= ?' : ''} ${q.dateTo ? 'AND DATE(l.txn_date) <= ?' : ''}
        ${q.item_group ? 'AND l.material_type = ?' : ''} ${q.warehouse_id ? 'AND l.warehouse_id = ?' : ''} ORDER BY l.txn_date, l.id`,
    [cid, ...(q.dateFrom ? [q.dateFrom] : []), ...(q.dateTo ? [q.dateTo] : []), ...(q.item_group ? [q.item_group] : []), ...(q.warehouse_id ? [q.warehouse_id] : [])]);
  const data = rows.map((r) => {
    const qty = r3(n(r.qty_in) - n(r.qty_out));
    return { doc_id: r.ref_id ? `OPN-${r.ref_id}` : `OPN-L${r.id}`, doc_date: dstr(r.txn_date), location: r.warehouse_name, so_no: r.so_no, style_no: r.style_code, season: r.season, buyer: r.buyer,
      item: r.item, item_type: r.material_type, color: r.color_name, size: r.size_label, uom: r.uom, qty, rate: r2(n(r.rate)), amount: r2(qty * n(r.rate)), prepared_by: r.prepared_by,
      order_type: r.order_type, doc_link: '/inventory/ledger' };
  });
  res.json({ data, meta: { footnotes: ['Opening stock entries posted to the stock ledger (ref type OPENING). Party / process / buyer dept / remarks are not captured on opening entries.'] } });
}));
