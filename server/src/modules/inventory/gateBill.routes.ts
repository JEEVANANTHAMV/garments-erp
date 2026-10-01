import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { processQuotations, openGateEntries, settingFlag } from '../../core/inwardControls.js';
import { knittingBillSources } from '../yarnProcess/knittingBill.routes.js';

/**
 * Client voice notes 01-Oct-2026:
 *   1. Every DC we print carries its number as a barcode; scanning it at the gate loads the DC
 *      into the outward gate pass (or, when the material comes back, into the inward gate entry).
 *   2. GRN bill tracking: for every GRN, has the supplier / contractor bill been received?
 *      (GET /procurement/grn-bill-status + the bell alerts.)
 */
export const gateBillRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const can = (req: Request, ...codes: string[]) => !!req.user?.isSuperAdmin || codes.some((c) => req.user?.permissions.has(c));

// =====================================================================================
// DC barcode lookup
// =====================================================================================
interface DcHit {
  dc_type: string; dc_label: string; ref_type: string; ref_id: number; dc_no: string; dc_date: string; status: string;
  party_id: number | null; party_name: string | null; vehicle_no: string | null; purpose: string; returnable: boolean;
  material_type: 'FABRIC' | 'YARN' | 'TRIM' | 'GARMENT' | 'GENERAL'; qty: number; uom_code: string; packages: number;
  expected_return_date: string | null; jobs: string | null;
}

async function findDc(cid: number, code: string): Promise<DcHit | null> {
  const c = code.trim();
  const fpo = await queryOne<any>(
    `SELECT o.id, o.fpo_no, o.fpo_date, o.status, o.vendor_id, v.party_name, o.vehicle_no, o.sub_process, o.is_reprocess, o.expected_return_date,
            COALESCE(SUM(ri.weight_kg), 0) kg, COUNT(ri.id) rolls, GROUP_CONCAT(DISTINCT ri.io_no SEPARATOR ', ') jobs
       FROM trx_fabric_process_order o LEFT JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id LEFT JOIN mst_party v ON v.id = o.vendor_id
      WHERE o.company_id = ? AND o.fpo_no = ? GROUP BY o.id`, [cid, c]);
  if (fpo) return { dc_type: 'FABRIC_PROCESS_DC', dc_label: fpo.is_reprocess ? 'Fabric reprocess DC' : 'Fabric process DC', ref_type: 'FABRIC_PROCESS_DC', ref_id: fpo.id, dc_no: fpo.fpo_no,
    dc_date: fpo.fpo_date, status: fpo.status, party_id: fpo.vendor_id, party_name: fpo.party_name, vehicle_no: fpo.vehicle_no, returnable: true, material_type: 'FABRIC',
    purpose: `Fabric ${String(fpo.sub_process).toLowerCase().replace(/_/g, ' ')} (job work) — DC ${fpo.fpo_no}`, qty: r3(n(fpo.kg)), uom_code: 'KG', packages: Number(fpo.rolls) || 0,
    expected_return_date: fpo.expected_return_date, jobs: fpo.jobs };
  const ypo = await queryOne<any>(
    `SELECT o.id, o.ypo_no, o.ypo_date, o.status, o.vendor_id, v.party_name, o.vehicle_no, o.process_code, pt.name process_name, o.is_reprocess, o.expected_return_date, o.total_kg,
            COALESCE(SUM(l.no_of_cones), 0) cones, COUNT(l.id) line_count, GROUP_CONCAT(DISTINCT l.io_no SEPARATOR ', ') jobs
       FROM trx_yarn_process_order o LEFT JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id LEFT JOIN mst_party v ON v.id = o.vendor_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = o.company_id AND pt.code = o.process_code
      WHERE o.company_id = ? AND o.ypo_no = ? GROUP BY o.id`, [cid, c]);
  if (ypo) return { dc_type: 'YARN_PROCESS_DC', dc_label: ypo.is_reprocess ? 'Yarn reprocess DC' : 'Yarn process DC', ref_type: 'YARN_PROCESS_DC', ref_id: ypo.id, dc_no: ypo.ypo_no,
    dc_date: ypo.ypo_date, status: ypo.status, party_id: ypo.vendor_id, party_name: ypo.party_name, vehicle_no: ypo.vehicle_no, returnable: true, material_type: 'YARN',
    purpose: `Yarn ${String(ypo.process_name ?? ypo.process_code).toLowerCase()} (job work) — DC ${ypo.ypo_no}`, qty: r3(n(ypo.total_kg)), uom_code: 'KG',
    packages: Number(ypo.cones) || Number(ypo.line_count) || 0, expected_return_date: ypo.expected_return_date, jobs: ypo.jobs };
  const pi = await queryOne<any>(
    `SELECT MIN(i.id) id, i.dc_no, MIN(i.issue_date) dc_date, MAX(i.src_type) src_type, MAX(i.vendor_id) vendor_id, MAX(v.party_name) party_name, MAX(i.vehicle_no) vehicle_no,
            SUM(i.issued_qty_kg) kg, SUM(i.no_of_cones) cones, COUNT(*) line_count, GROUP_CONCAT(DISTINCT i.io_no SEPARATOR ', ') jobs
       FROM trx_process_issue i LEFT JOIN mst_party v ON v.id = i.vendor_id
      WHERE i.company_id = ? AND i.dc_no = ? AND i.src_type IN ('KNITTING_PROGRAM', 'YARN_PROCESS') GROUP BY i.dc_no`, [cid, c]);
  if (pi) {
    const knit = pi.src_type === 'KNITTING_PROGRAM';
    return { dc_type: knit ? 'KNITTING_DC' : 'YARN_DC', dc_label: knit ? 'Knitting DC (yarn outward)' : 'Yarn process DC', ref_type: knit ? 'KNITTING_DC' : 'YARN_DC', ref_id: pi.id,
      dc_no: pi.dc_no, dc_date: pi.dc_date, status: 'ISSUED', party_id: pi.vendor_id, party_name: pi.party_name, vehicle_no: pi.vehicle_no, returnable: true, material_type: 'YARN',
      purpose: `${knit ? 'Yarn for knitting' : 'Yarn processing'} (job work) — DC ${pi.dc_no}`, qty: r3(n(pi.kg)), uom_code: 'KG', packages: Number(pi.cones) || Number(pi.line_count) || 0,
      expected_return_date: null, jobs: pi.jobs };
  }
  const jw = await queryOne<any>(
    `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, jc.vendor_id, v.party_name, jc.vehicle_no, jc.total_qty, jc.expected_return, jc.io_no, ps.stage_name,
            (SELECT COUNT(*) FROM trx_jobwork_challan_line l WHERE l.challan_id = jc.id) line_count
       FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE jc.company_id = ? AND jc.challan_no = ?`, [cid, c]);
  if (jw) return { dc_type: 'JOBWORK_DC', dc_label: 'Job work DC', ref_type: 'JW_CHALLAN', ref_id: jw.id, dc_no: jw.challan_no, dc_date: jw.challan_date, status: jw.status,
    party_id: jw.vendor_id, party_name: jw.party_name, vehicle_no: jw.vehicle_no, returnable: true, material_type: 'GARMENT',
    purpose: `${jw.stage_name ?? 'Job work'} (job work) — DC ${jw.challan_no}`, qty: n(jw.total_qty), uom_code: 'PCS', packages: Number(jw.line_count) || 0,
    expected_return_date: jw.expected_return, jobs: jw.io_no };
  const pr = await queryOne<any>(
    `SELECT r.id, r.return_no, r.return_dc_no, COALESCE(r.return_dc_date, r.return_date) dc_date, r.status, r.supplier_id, v.party_name, r.vehicle_no, r.total_qty, r.material_category
       FROM trx_purchase_return r LEFT JOIN mst_party v ON v.id = r.supplier_id
      WHERE r.company_id = ? AND (r.return_dc_no = ? OR r.return_no = ?) LIMIT 1`, [cid, c, c]);
  if (pr) {
    const mat = String(pr.material_category ?? '').toUpperCase();
    return { dc_type: 'PURCHASE_RETURN_DC', dc_label: 'Purchase return DC', ref_type: 'PURCHASE_RETURN', ref_id: pr.id, dc_no: pr.return_dc_no || pr.return_no, dc_date: pr.dc_date,
      status: pr.status, party_id: pr.supplier_id, party_name: pr.party_name, vehicle_no: pr.vehicle_no, returnable: false,
      material_type: mat.includes('YARN') ? 'YARN' : mat.includes('FABRIC') ? 'FABRIC' : mat.includes('TRIM') ? 'TRIM' : 'GENERAL',
      purpose: `Purchase return to supplier — ${pr.return_no}`, qty: n(pr.total_qty), uom_code: mat.includes('YARN') || mat.includes('FABRIC') ? 'KG' : 'PCS', packages: 0,
      expected_return_date: null, jobs: null };
  }
  const ds = await queryOne<any>(
    `SELECT d.id, d.dispatch_no, d.dispatch_date, d.buyer_id, b.party_name, d.vehicle_no, d.total_qty, d.total_cartons, d.io_no
       FROM trx_dispatch d LEFT JOIN mst_party b ON b.id = d.buyer_id WHERE d.company_id = ? AND d.dispatch_no = ?`, [cid, c]);
  if (ds) return { dc_type: 'DISPATCH', dc_label: 'Dispatch / delivery challan', ref_type: 'DISPATCH', ref_id: ds.id, dc_no: ds.dispatch_no, dc_date: ds.dispatch_date, status: 'DISPATCHED',
    party_id: ds.buyer_id, party_name: ds.party_name, vehicle_no: ds.vehicle_no, returnable: false, material_type: 'GARMENT',
    purpose: `Export / sales dispatch — ${ds.dispatch_no}`, qty: n(ds.total_qty), uom_code: 'PCS', packages: Number(ds.total_cartons) || 0, expected_return_date: null, jobs: ds.io_no };
  return null;
}

/** GET /dc-lookup?code= — what a scanned DC barcode is, pre-filled for the gate pass / gate entry. */
gateBillRouter.get('/dc-lookup', requireAny('GATE_OUTWARD.VIEW', 'GATE_INWARD.VIEW', 'GATE_OUTWARD.CREATE', 'GATE_INWARD.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const code = z.string().trim().min(2).max(80).parse(req.query.code);
  const hit = await findDc(cid, code);
  if (!hit) throw NotFound(`No DC "${code}" — scan the barcode on our DC print (fabric / yarn process, knitting, job work, purchase return, dispatch)`);
  const uom = await queryOne<any>('SELECT id FROM cfg_uom WHERE code = ? LIMIT 1', [hit.uom_code]);
  const passes = await query<any>(`SELECT id, pass_no, pass_date, pass_time, status FROM trx_gate_outward WHERE company_id = ? AND ((ref_type = ? AND ref_id = ?) OR ref_no = ?) ORDER BY id`,
    [cid, hit.ref_type, hit.ref_id, hit.dc_no]);
  const inwards = await query<any>(`SELECT id, entry_no, entry_date, entry_time, status FROM trx_gate_inward WHERE company_id = ? AND ((ref_type = ? AND ref_id = ?) OR ref_no = ?) ORDER BY id`,
    [cid, hit.ref_type, hit.ref_id, hit.dc_no]);
  const warnings: string[] = [];
  if (['DRAFT', 'CANCELLED'].includes(String(hit.status))) warnings.push(`${hit.dc_no} is ${String(hit.status).toLowerCase()} — confirm the DC before it leaves the gate`);
  if (passes.length) warnings.push(`Gate pass already made for ${hit.dc_no}: ${passes.map((p) => p.pass_no).join(', ')}`);
  res.json({ data: { ...hit, uom_id: uom?.id ?? null, gate_passes: passes, gate_inwards: inwards, warnings } });
}));

// =====================================================================================
// GRN bill tracking
// =====================================================================================
export interface BillRow {
  source: 'PURCHASE' | 'TRIM' | 'FABRIC_PROCESS' | 'YARN_PROCESS' | 'KNITTING'; grn_id: number; grn_no: string; grn_date: string; days: number; supplier_id: number | null; supplier: string | null;
  po_nos: string | null; material: string; supplier_inv_no: string | null; grn_qty: number; grn_value: number; billed_value: number; bill_nos: string | null; bill_status: string | null;
  status: 'PENDING' | 'PARTIAL' | 'RECEIVED'; overdue: boolean; link: string;
}
const parseIds = (v: unknown): number[] => {
  if (!v) return [];
  try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number).filter(Boolean) : []; } catch { return []; }
};

export async function grnBillRows(cid: number, alertDays: number): Promise<BillRow[]> {
  const out: BillRow[] = [];
  // ---- purchase GRNs (yarn / fabric / general) against supplier bills ----
  const grns = await query<any>(
    `SELECT g.id, g.grn_no, g.grn_date, DATEDIFF(CURDATE(), g.grn_date) days, g.supplier_id, p.party_name supplier, COALESCE(NULLIF(g.supplier_inv_no, ''), gin.supplier_inv_no) inv_no,
            (SELECT GROUP_CONCAT(DISTINCT po.po_no SEPARATOR ', ') FROM trx_grn_line gl JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) WHERE gl.grn_id = g.id) po_nos,
            (SELECT GROUP_CONCAT(DISTINCT gl.material_type) FROM trx_grn_line gl WHERE gl.grn_id = g.id) material,
            (SELECT SUM(gl.accepted_qty) FROM trx_grn_line gl WHERE gl.grn_id = g.id) qty,
            (SELECT SUM(COALESCE(NULLIF(gl.total_amount, 0), gl.accepted_qty * gl.rate)) FROM trx_grn_line gl WHERE gl.grn_id = g.id) value
       FROM trx_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
      WHERE g.company_id = ? AND (g.po_id IS NOT NULL OR EXISTS (SELECT 1 FROM trx_grn_line gl WHERE gl.grn_id = g.id AND (gl.po_line_id IS NOT NULL OR gl.po_id IS NOT NULL)))
      ORDER BY g.grn_date, g.id`, [cid]);
  const bills = await query<any>(`SELECT id, bill_no, bill_date, status, grn_id, grn_ids, trim_grn_ids, total_amount FROM trx_supplier_bill WHERE company_id = ? AND status <> 'CANCELLED'`, [cid]);
  const blines = bills.length ? await query<any>('SELECT bill_id, grn_id, grn_line_id, amount, bill_qty FROM trx_supplier_bill_line WHERE bill_id IN (?)', [bills.map((b) => b.id)]) : [];
  const glines = grns.length ? await query<any>('SELECT id, grn_id FROM trx_grn_line WHERE grn_id IN (?)', [grns.map((g) => g.id)]) : [];
  const lineGrn = new Map(glines.map((l) => [Number(l.id), Number(l.grn_id)]));
  const billById = new Map(bills.map((b) => [Number(b.id), b]));
  for (const g of grns) {
    const gid = Number(g.id);
    const lineHits = blines.filter((l) => Number(l.grn_id) === gid || (l.grn_line_id && lineGrn.get(Number(l.grn_line_id)) === gid));
    const headerHits = bills.filter((b) => Number(b.grn_id) === gid || parseIds(b.grn_ids).includes(gid));
    const billIds = new Set<number>([...lineHits.map((l) => Number(l.bill_id)), ...headerHits.map((b) => Number(b.id))]);
    const billed = lineHits.reduce((a, l) => a + n(l.amount), 0);
    const value = n(g.value);
    // a bill linked to the GRN without line-level amounts covers the GRN
    const headerOnly = headerHits.some((b) => !blines.some((l) => Number(l.bill_id) === Number(b.id) && (Number(l.grn_id) === gid || lineGrn.get(Number(l.grn_line_id)) === gid)));
    const status = !billIds.size ? 'PENDING' : headerOnly || value <= 0 || billed >= value * 0.98 ? 'RECEIVED' : 'PARTIAL';
    const bl = [...billIds].map((i) => billById.get(i)).filter(Boolean);
    out.push({ source: 'PURCHASE', grn_id: gid, grn_no: g.grn_no, grn_date: g.grn_date, days: Number(g.days) || 0, supplier_id: g.supplier_id, supplier: g.supplier, po_nos: g.po_nos,
      material: String(g.material ?? 'GENERAL'), supplier_inv_no: g.inv_no, grn_qty: r3(n(g.qty)), grn_value: r2(value), billed_value: r2(headerOnly && !billed ? value : billed),
      bill_nos: bl.map((b: any) => b.bill_no).join(', ') || null, bill_status: bl.map((b: any) => b.status).join(', ') || null,
      status, overdue: status !== 'RECEIVED' && Number(g.days) > alertDays, link: '' });
  }
  // ---- trim GRNs ----
  const tg = await query<any>(
    `SELECT g.id, g.grn_no, g.grn_date, DATEDIFF(CURDATE(), g.grn_date) days, g.supplier_id, p.party_name supplier, COALESCE(NULLIF(g.supplier_inv_no, ''), gin.supplier_inv_no) inv_no,
            g.net_amount, (SELECT SUM(l.accepted_qty) FROM trx_trim_grn_line l WHERE l.grn_id = g.id) qty, po.po_no
       FROM trx_trim_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id LEFT JOIN trx_trim_po po ON po.id = g.po_id
      WHERE g.company_id = ? AND COALESCE(g.status, '') <> 'CANCELLED' ORDER BY g.grn_date, g.id`, [cid]).catch(() => [] as any[]);
  for (const g of tg) {
    const bl = bills.filter((b) => parseIds(b.trim_grn_ids).includes(Number(g.id)));
    const status = bl.length ? 'RECEIVED' : 'PENDING';
    out.push({ source: 'TRIM', grn_id: Number(g.id), grn_no: g.grn_no, grn_date: g.grn_date, days: Number(g.days) || 0, supplier_id: g.supplier_id, supplier: g.supplier, po_nos: g.po_no,
      material: 'TRIM', supplier_inv_no: g.inv_no, grn_qty: r3(n(g.qty)), grn_value: r2(n(g.net_amount)), billed_value: bl.length ? r2(n(g.net_amount)) : 0,
      bill_nos: bl.map((b) => b.bill_no).join(', ') || null, bill_status: bl.map((b) => b.status).join(', ') || null, status, overdue: status !== 'RECEIVED' && Number(g.days) > alertDays, link: '' });
  }
  // ---- process GRNs (fabric / yarn) against contractor bills ----
  for (const [src, tbl, billTbl, mat] of [['FABRIC_PROCESS', 'trx_fabric_process_inward', 'trx_fabric_process_bill', 'FABRIC'], ['YARN_PROCESS', 'trx_yarn_process_inward', 'trx_yarn_process_bill', 'YARN']] as const) {
    const rows = await query<any>(
      `SELECT i.id, i.inward_no, i.inward_date, DATEDIFF(CURDATE(), i.inward_date) days, i.vendor_id, p.party_name supplier, i.challan_no, i.good_kg, i.bill_id, b.bill_no, b.status bill_status, b.net_amount
         FROM ${tbl} i LEFT JOIN mst_party p ON p.id = i.vendor_id LEFT JOIN ${billTbl} b ON b.id = i.bill_id
        WHERE i.company_id = ? AND i.status = 'POSTED' AND i.is_reprocess = 0 ORDER BY i.inward_date, i.id`, [cid]).catch(() => [] as any[]);
    for (const i of rows) {
      const status = i.bill_id && i.bill_status !== 'CANCELLED' ? 'RECEIVED' : 'PENDING';
      out.push({ source: src, grn_id: Number(i.id), grn_no: i.inward_no, grn_date: i.inward_date, days: Number(i.days) || 0, supplier_id: i.vendor_id, supplier: i.supplier, po_nos: null,
        material: mat, supplier_inv_no: i.challan_no, grn_qty: r3(n(i.good_kg)), grn_value: 0, billed_value: 0, bill_nos: status === 'RECEIVED' ? i.bill_no : null,
        bill_status: status === 'RECEIVED' ? i.bill_status : null, status, overdue: status !== 'RECEIVED' && Number(i.days) > alertDays, link: '' });
    }
  }
  // ---- knitting GRNs (job-work knitters) against knitting bills ----
  for (const k of await knittingBillSources(cid)) {
    const billed = !!k.bill_id && k.bill_status !== 'CANCELLED';
    out.push({ source: 'KNITTING', grn_id: Number(k.receipt_id), grn_no: k.receipt_no, grn_date: k.receipt_date, days: Number(k.days) || 0, supplier_id: k.vendor_id, supplier: k.vendor_name,
      po_nos: k.dc_nos, material: 'FABRIC', supplier_inv_no: k.party_dc_no, grn_qty: k.fabric_kg, grn_value: k.quotation_rate != null ? r2(k.fabric_kg * k.quotation_rate) : 0,
      billed_value: 0, bill_nos: billed ? k.bill_no : null, bill_status: billed ? k.bill_status : null, status: billed ? 'RECEIVED' : 'PENDING',
      overdue: !billed && Number(k.days) > alertDays, link: '' });
  }
  const LINK: Record<string, (r: BillRow) => string> = {
    PURCHASE: (r) => (r.material.includes('YARN') ? `/procurement/yarn/grn/${r.grn_id}` : r.material.includes('FABRIC') ? `/procurement/fabric/grn/${r.grn_id}` : '/procurement/grns'),
    TRIM: (r) => `/procurement/trim/grn/${r.grn_id}`, KNITTING: () => '/procurement/supplier-bills?tab=KNITTING', FABRIC_PROCESS: (r) => `/production/fabric-process/inward?id=${r.grn_id}`, YARN_PROCESS: (r) => `/production/yarn-process/inward?id=${r.grn_id}`,
  };
  out.forEach((r) => { r.link = LINK[r.source](r); });
  return out;
}

const alertDaysOf = async (cid: number) => Number((await queryOne<any>(`SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'BILL_PENDING_ALERT_DAYS'`, [cid]))?.v) || 7;

/** GET /procurement/grn-bill-status — every GRN with its supplier / contractor bill status. */
gateBillRouter.get('/procurement/grn-bill-status', requireAny('GRN.VIEW', 'PURCHASE.VIEW', 'FABRIC_PROCESS.VIEW', 'YARN_PROCESS.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.string().optional(), source: z.string().optional(), supplier_id: z.coerce.number().int().optional(), from: z.string().optional(), to: z.string().optional(),
    overdue: z.coerce.number().int().optional() }).parse(req.query);
  const days = await alertDaysOf(cid);
  let rows = await grnBillRows(cid, days);
  if (q.status) rows = rows.filter((r) => (q.status === 'OPEN' ? r.status !== 'RECEIVED' : r.status === q.status));
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.supplier_id) rows = rows.filter((r) => Number(r.supplier_id) === q.supplier_id);
  if (q.from) rows = rows.filter((r) => String(r.grn_date).slice(0, 10) >= q.from!);
  if (q.to) rows = rows.filter((r) => String(r.grn_date).slice(0, 10) <= q.to!);
  if (q.overdue) rows = rows.filter((r) => r.overdue);
  const sum = (st: string) => { const x = rows.filter((r) => r.status === st); return { count: x.length, value: r2(x.reduce((a, r) => a + r.grn_value - r.billed_value, 0)) }; };
  res.json({ data: rows.sort((a, b) => b.days - a.days), summary: { alert_days: days, pending: sum('PENDING'), partial: sum('PARTIAL'), received: sum('RECEIVED'), overdue: rows.filter((r) => r.overdue).length } });
}));

/** GET /alerts — live alerts for the bell (computed, so they are always current). */
gateBillRouter.get('/alerts', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const items: { key: string; title: string; body: string; count: number; severity: 'info' | 'warning' | 'danger'; link: string }[] = [];
  const purchase = can(req, 'GRN.VIEW', 'PURCHASE.VIEW'), process = can(req, 'FABRIC_PROCESS.VIEW', 'YARN_PROCESS.VIEW', 'PRODUCTION.VIEW');
  if (purchase || process) {
    const days = await alertDaysOf(cid);
    const rows = (await grnBillRows(cid, days)).filter((r) => r.status !== 'RECEIVED');
    const sup = rows.filter((r) => purchase && (r.source === 'PURCHASE' || r.source === 'TRIM'));
    const pro = rows.filter((r) => process && (r.source === 'FABRIC_PROCESS' || r.source === 'YARN_PROCESS' || r.source === 'KNITTING'));
    const add = (key: string, label: string, list: BillRow[], status: string) => {
      if (!list.length) return;
      const over = list.filter((r) => r.overdue);
      const oldest = Math.max(...list.map((r) => r.days));
      items.push({ key, count: list.length, severity: over.length ? 'danger' : 'warning', link: `/procurement/grn-bill-status?status=OPEN&source=${status}`,
        title: `${list.length} ${label} waiting for the bill`,
        body: `${over.length ? `${over.length} overdue (> ${days} days) · ` : ''}oldest ${oldest} day(s)${list.some((r) => r.grn_value > r.billed_value) ? ` · ₹${r2(list.reduce((a, r) => a + Math.max(0, r.grn_value - r.billed_value), 0)).toLocaleString('en-IN')} not billed` : ''}` });
    };
    add('GRN_BILL_PENDING', 'supplier GRN(s)', sup.filter((r) => r.source === 'PURCHASE'), 'PURCHASE');
    add('TRIM_GRN_BILL_PENDING', 'trim GRN(s)', sup.filter((r) => r.source === 'TRIM'), 'TRIM');
    add('PROCESS_GRN_BILL_PENDING', 'process GRN(s) (contractor bill)', pro, '');
  }
  if (can(req, 'GATE_INWARD.VIEW', 'GATE_OUTWARD.VIEW', 'PRODUCTION.VIEW')) {
    // returnable DCs past their expected return date
    const late = await query<any>(
      `SELECT ypo_no dc_no, expected_return_date FROM trx_yarn_process_order WHERE company_id = ? AND status IN ('CONFIRMED','PARTIALLY_RECEIVED') AND expected_return_date < CURDATE()
       UNION ALL SELECT fpo_no, expected_return_date FROM trx_fabric_process_order WHERE company_id = ? AND status IN ('DISPATCHED','PARTIALLY_RECEIVED','IN_PROCESS') AND expected_return_date < CURDATE()`,
      [cid, cid]).catch(() => [] as any[]);
    if (late.length) items.push({ key: 'DC_RETURN_OVERDUE', count: late.length, severity: 'warning', link: '/production/yarn-process/reports',
      title: `${late.length} process DC(s) past the expected return date`, body: late.slice(0, 4).map((l) => l.dc_no).join(', ') + (late.length > 4 ? ' …' : '') });
  }
  res.json({ data: items });
}));

// =====================================================================================
// GRN print (inward document with its barcode)
// =====================================================================================
gateBillRouter.get('/grn-print/:kind/:id', requireAny('GRN.VIEW', 'PURCHASE.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const kind = z.enum(['grn', 'trim']).parse(req.params.kind);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const company = await queryOne<any>('SELECT legal_name, trade_name, address_line1, address_line2, city, state, pincode, gstin FROM mst_company WHERE id = ?', [cid]).catch(() => null);
  if (kind === 'grn') {
    const g = await queryOne<any>(
      `SELECT g.grn_no, g.grn_date, g.supplier_dc_no, g.supplier_inv_no, g.vehicle_no, g.internal_ir_no io_no, g.remarks, p.party_name supplier, w.warehouse_name, gin.entry_no gate_entry_no,
              (SELECT GROUP_CONCAT(DISTINCT po.po_no SEPARATOR ', ') FROM trx_grn_line gl JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) WHERE gl.grn_id = g.id) po_nos
         FROM trx_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
        WHERE g.id = ? AND g.company_id = ?`, [id, cid]);
    if (!g) throw NotFound('GRN not found');
    const lines = await query<any>(
      `SELECT gl.material_type, COALESCE(y.yarn_name, fb.fabric_name, gl.yarn_type, gl.fabric_category) item, gl.color_name, gl.lot_no, gl.no_of_rolls packs,
              gl.received_qty, gl.accepted_qty, gl.rejected_qty, u.code uom
         FROM trx_grn_line gl LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_fabric fb ON fb.id = gl.fabric_id LEFT JOIN cfg_uom u ON u.id = gl.uom_id
        WHERE gl.grn_id = ? ORDER BY gl.id`, [id]);
    res.json({ data: { ...g, company, lines } });
    return;
  }
  const g = await queryOne<any>(
    `SELECT g.grn_no, g.grn_date, g.supplier_dc_no, g.supplier_inv_no, g.vehicle_no, g.io_no, g.remarks, p.party_name supplier, w.warehouse_name, po.po_no po_nos, gin.entry_no gate_entry_no
       FROM trx_trim_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN trx_trim_po po ON po.id = g.po_id
       LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id WHERE g.id = ? AND g.company_id = ?`, [id, cid]);
  if (!g) throw NotFound('Trim GRN not found');
  const lines = await query<any>(
    `SELECT 'TRIM' material_type, t.trim_name item, l.color_name, l.internal_lot_no lot_no, NULL packs, l.received_qty, l.accepted_qty, l.rejected_qty, u.code uom, l.trim_size
       FROM trx_trim_grn_line l LEFT JOIN mst_trim t ON t.id = l.trim_id LEFT JOIN cfg_uom u ON u.id = l.uom_id WHERE l.grn_id = ? ORDER BY l.id`, [id]);
  res.json({ data: { ...g, company, lines } });
}));

// =====================================================================================
// Pickers for the process DCs / inwards
// =====================================================================================
/** GET /process-quotations?vendor_id=&material=&process= — the vendor's accepted (approved) process quotations with line rates. */
gateBillRouter.get('/process-quotations', requireAny('PRODUCTION.VIEW', 'FABRIC_PROCESS.VIEW', 'YARN_PROCESS.VIEW', 'QUOTATION.VIEW'), ah(async (req, res) => {
  const q = z.object({ vendor_id: z.coerce.number().int().positive(), material: z.string().optional(), process: z.string().optional(),
    io_no: z.string().trim().max(60).optional(), so_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  res.json({ data: await processQuotations(req.user!.companyId, q), required: await settingFlag(req.user!.companyId, 'PROCESS_QUOTATION_REQUIRED', false) });
}));

/** GET /gate-entries/open?party_id= — recent gate entries of the party, to map on an inward. */
gateBillRouter.get('/gate-entries/open', requireAny('GRN.VIEW', 'PRODUCTION.VIEW', 'GATE_INWARD.VIEW', 'FABRIC_PROCESS.VIEW', 'YARN_PROCESS.VIEW', 'PURCHASE.VIEW'), ah(async (req, res) => {
  const q = z.object({ party_id: z.coerce.number().int().optional() }).parse(req.query);
  res.json({ data: await openGateEntries(req.user!.companyId, q.party_id ?? null), required: await settingFlag(req.user!.companyId, 'GATE_ENTRY_REQUIRED_FOR_INWARD', false) });
}));
