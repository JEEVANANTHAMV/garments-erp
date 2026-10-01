import type { Request } from 'express';
import { z } from 'zod';
import { queryOne, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { BadRequest } from '../../core/errors.js';
import { nextDocNumber } from '../../core/numbering.js';

/**
 * Shared bits of the Yarn Process engine (Garment_ERP_Yarn_Process_Developer_Document):
 * permissions, process types, yarn lot moves and cone history.
 *
 * Stock model: a yarn lot is a yarn GRN line (trx_grn_line). Processed output, reject and
 * returned yarn become new lots (parent_grn_line_id → the lot they came from); every KG that
 * leaves a lot is a trx_process_issue line against its grn_line_id, which the yarn stock
 * (yarnStockRows / yarnJobLots) already subtracts.
 */
export const YP = {
  VIEW: 'YARN_PROCESS.VIEW', CREATE: 'YARN_PROCESS.CREATE', EDIT_DRAFT: 'YARN_PROCESS.EDIT_DRAFT', CONFIRM: 'YARN_PROCESS.CONFIRM',
  QC: 'YARN_PROCESS.QC', RETURN: 'YARN_PROCESS.RETURN', REPROCESS: 'YARN_PROCESS.REPROCESS', BILLING_APPROVE: 'YARN_PROCESS.BILLING_APPROVE',
  BILLING_CHANGE: 'YARN_PROCESS.BILLING_CHANGE', BILL: 'YARN_PROCESS.BILL', BILL_CANCEL: 'YARN_PROCESS.BILL_CANCEL', CANCEL: 'YARN_PROCESS.CANCEL',
  MASTER: 'YARN_PROCESS.MASTER',
} as const;
export const can = (req: Request, code: string) => !!req.user?.isSuperAdmin || !!req.user?.permissions.has(code);

export const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const n = (v: unknown) => Number(v ?? 0) || 0;
export const EPS = 0.0005;
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function processType(cid: number, code: string, runner?: Tx) {
  const sql = 'SELECT * FROM mst_yarn_process_type WHERE company_id = ? AND code = ? AND is_active = 1';
  const row = runner ? await txQueryOne<any>(runner, sql, [cid, code]) : await queryOne<any>(sql, [cid, code]);
  if (!row) throw BadRequest(`Unknown yarn process "${code}"`);
  return row;
}

export const whName = async (tx: Tx, id: number | null | undefined) =>
  id ? String((await txQueryOne<any>(tx, 'SELECT warehouse_name FROM mst_warehouse WHERE id = ?', [id]))?.warehouse_name ?? `Store ${id}`) : null;
export const partyName = async (tx: Tx, id: number | null | undefined) =>
  id ? String((await txQueryOne<any>(tx, 'SELECT party_name FROM mst_party WHERE id = ?', [id]))?.party_name ?? '') : null;

/** One line of yarn lot / cone history (cone tracking). */
export async function coneHistory(tx: Tx, req: Request, h: {
  grn_line_id?: number | null; lot_no?: string | null; cone_no?: string | null; event: string; ref_type: string; ref_id?: number | null; ref_no?: string | null;
  process_code?: string | null; from?: string | null; to?: string | null; qty: number; so_id?: number | null; related_grn_line_id?: number | null; remarks?: string | null;
}) {
  await txExecute(tx,
    `INSERT INTO trx_yarn_cone_history (company_id, grn_line_id, lot_no, cone_no, event, ref_type, ref_id, ref_no, process_code, from_place, to_place,
       qty_kg, so_id, related_grn_line_id, remarks, user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, h.grn_line_id ?? null, h.lot_no ?? null, h.cone_no ?? null, h.event, h.ref_type, h.ref_id ?? null, h.ref_no ?? null,
     h.process_code ?? null, h.from ?? null, h.to ?? null, r3(h.qty), h.so_id ?? null, h.related_grn_line_id ?? null, h.remarks ?? null, req.user!.id]);
}

/** A yarn lot (GRN line) with its store, job and KG left (accepted − every issue against the lot). */
export async function lotRow(tx: Tx, cid: number, grnLineId: number, lock = false) {
  const l = await txQueryOne<any>(tx,
    `SELECT gl.*, g.grn_no, g.grn_date, g.warehouse_id, g.supplier_id, y.yarn_name, w.warehouse_name,
            COALESCE(so.io_no, so.so_no) AS job_no, so.buyer_po_no,
            gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0)
              - COALESCE((SELECT SUM(prl.return_qty) FROM trx_purchase_return_line prl JOIN trx_purchase_return pr ON pr.id = prl.return_id
                           WHERE prl.grn_line_id = gl.id AND pr.status <> 'CANCELLED' AND pr.stock_posted = 1), 0) AS balance_kg
       FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
       LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = gl.so_id
      WHERE gl.id = ? AND g.company_id = ? AND gl.material_type = 'YARN'${lock ? ' FOR UPDATE' : ''}`, [grnLineId, cid]).catch(async (e) => {
    // installs without purchase-return stock posting
    if (!String(e?.message).includes('stock_posted')) throw e;
    return txQueryOne<any>(tx,
      `SELECT gl.*, g.grn_no, g.grn_date, g.warehouse_id, g.supplier_id, y.yarn_name, w.warehouse_name, COALESCE(so.io_no, so.so_no) AS job_no, so.buyer_po_no,
              gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0) AS balance_kg
         FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
         LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN trx_sales_order so ON so.id = gl.so_id
        WHERE gl.id = ? AND g.company_id = ? AND gl.material_type = 'YARN'`, [grnLineId, cid]);
  });
  if (!l) throw BadRequest('Yarn lot not found');
  return { ...l, balance_kg: r3(n(l.balance_kg)) };
}

/**
 * Takes KG out of a yarn lot (DC issue, return, write-off) as a trx_process_issue line — the yarn
 * stock subtracts it from the lot. A negative qty reverses an earlier move (DC cancel).
 */
export async function lotOut(tx: Tx, req: Request, m: {
  lot: any; qty: number; srcType: 'YARN_PROC_DC' | 'YARN_LOT_MOVE'; srcId: number; srcLineId?: number | null; date: string; dcNo?: string | null;
  vendorId?: number | null; vehicleNo?: string | null; cones?: number; soId?: number | null; ioNo?: string | null; remarks?: string | null; refType: string;
}) {
  const cid = req.user!.companyId;
  const issueNo = await nextDocNumber(tx, cid, m.srcType === 'YARN_PROC_DC' ? 'PROC_ISSUE' : 'YP_LOT_MOVE');
  const r = await txExecute(tx,
    `INSERT INTO trx_process_issue (company_id, issue_no, dc_no, vendor_id, vehicle_no, issue_date, src_type, src_id, src_line_id, yarn_id, lot_no,
       warehouse_id, issued_qty_kg, no_of_cones, remarks, created_by, grn_line_id, so_id, io_no)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, issueNo, m.dcNo ?? null, m.vendorId ?? null, m.vehicleNo ?? null, m.date, m.srcType, m.srcId, m.srcLineId ?? null, m.lot.yarn_id ?? null,
     m.lot.lot_no ?? null, m.lot.warehouse_id, r3(m.qty), m.cones ?? 0, m.remarks ?? null, req.user!.id, m.lot.id, m.soId ?? null, m.ioNo ?? null]);
  if (m.lot.warehouse_id) {
    await postLedger(tx, {
      companyId: cid, warehouseId: Number(m.lot.warehouse_id), materialType: 'YARN', yarnId: Number(m.lot.yarn_id) || null, soId: m.soId ?? null,
      txnType: m.qty >= 0 ? 'ISSUE' : 'RETURN', refType: m.refType, refId: m.srcId,
      ...(m.qty >= 0 ? { qtyOut: r3(m.qty) } : { qtyIn: r3(-m.qty) }), uomId: UOM_KG, createdBy: req.user!.id,
    });
  }
  return Number(r.insertId);
}

/** Creates a GRN (header) that new yarn lots hang off — processed output, reject or return store. */
export async function lotGrn(tx: Tx, req: Request, g: { no: string; date: string; warehouseId: number; supplierId?: number | null; ioNo?: string | null; dcNo?: string | null; vehicleNo?: string | null; remarks: string; rejected?: boolean }) {
  const r = await txExecute(tx,
    `INSERT INTO trx_grn (company_id, grn_no, internal_ir_no, grn_date, supplier_id, warehouse_id, supplier_dc_no, vehicle_no, qc_status, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, g.no, g.ioNo ?? null, g.date, g.supplierId ?? null, g.warehouseId, g.dcNo ?? null, g.vehicleNo ?? null,
     g.rejected ? 'REJECTED' : 'ACCEPTED', g.remarks, req.user!.id]);
  return Number(r.insertId);
}

/** A new yarn lot (GRN line) — good output (ACCEPTED) or reject / returned yarn (REJECTED). */
export async function lotIn(tx: Tx, l: {
  grnId: number; soId?: number | null; styleId?: number | null; yarnId?: number | null; yarnType?: string | null; shade?: string | null; lotNo: string;
  coneNo?: string | null; cones?: number; qty: number; rejected?: boolean; parentId?: number | null; ypoId?: number | null;
}) {
  const r = await txExecute(tx,
    `INSERT INTO trx_grn_line (grn_id, so_id, style_id, material_type, yarn_id, yarn_type, shade_code, color_name, lot_no, cone_no, no_of_rolls, qc_status,
       received_qty, received_weight, accepted_qty, rejected_qty, balance_qty, uom_id, parent_grn_line_id, source_ypo_id)
     VALUES (?,?,?,'YARN',?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    [l.grnId, l.soId ?? null, l.styleId ?? null, l.yarnId ?? null, l.yarnType ?? null, l.shade ?? null, l.shade ?? null, l.lotNo, l.coneNo ?? null, l.cones ?? 0,
     l.rejected ? 'REJECTED' : 'ACCEPTED', r3(l.qty), r3(l.qty), r3(l.qty), UOM_KG, l.parentId ?? null, l.ypoId ?? null]);
  return Number(r.insertId);
}
