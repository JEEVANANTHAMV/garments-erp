import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { computePreCosting, PRE_COST_HEADS } from './preCostingCalc.js';

export const costingRouter = Router();

/* ==============================================================================
   PART A: PRODUCTION ACTUAL COSTING ENDPOINTS
   ============================================================================== */

/**
 * 1. GET /api/production-costs/order-data/:prodOrderId
 *
 * Actual cost of a production order built ONLY from ERP transactions of its job
 * (IO no + style) — client review 24-Sep-2026: the management P&L of standard
 * (approved pre-costing) vs actual. A head with no source data is 0 and flagged
 * NO_DATA; nothing is estimated.
 *
 *   Fabric    fabric rolls issued to cutting × the roll's GRN rate (rolls from our
 *             own knitting carry no purchase rate — their cost is the yarn below)
 *   Yarn      yarn issued to knitting / yarn processes × lot GRN rate
 *             (else weighted receipt rate, else the item's standard rate — flagged)
 *   Trims     material issues against the production order × receipt rate
 *   Job work  process inwards on DCs of the job × DC rate (mistake PCS paid only
 *             when the process says so) — stitching, ironing, packing, printing …
 *   In-house  cutting / sewing / overhead only from company rate settings
 *             (COSTING_CUTTING_RATE_PER_PC, COSTING_SEWING_RATE_PER_PC,
 *             COSTING_OVERHEAD_PER_PC); blank setting → NO_DATA
 *   Quantity  bundle ledger (cut, sewn, finished, QC, packed) and FG receipts
 *
 * Standard figures are converted to INR: sales order exchange rate (same
 * currency), else the latest rate in trx_exchange_rate; with no rate the
 * variance is not computed.
 */
type HeadSource = 'TRANSACTIONS' | 'RATE_SETTING' | 'NO_DATA';
interface CostHead { key: string; label: string; amount: number; source: HeadSource; note: string; docs: number }

const r2 = (v: number) => Math.round(v * 100) / 100;
const numv = (v: unknown) => Number(v) || 0;
const SEW_STAGES = ['STITCH', 'STITCHING', 'SEW', 'SEWING'];
const FIN_STAGES = ['IRON', 'IRONING', 'FINISH', 'FINISHING', 'PRESS', 'CHECK', 'CHECKING'];
const PACK_STAGES = ['PACK', 'PACKING'];
const EMB_STAGES = ['PRINT', 'PRINTING', 'EMB', 'EMBROIDERY'];

/** Weighted receipt rate of an item (GRN / opening rows of the stock ledger), else its standard rate. */
async function receiptRate(companyId: number, type: 'YARN' | 'FABRIC' | 'TRIM', itemId: number | null) {
  if (!itemId) return { rate: 0, basis: 'NO_RATE' as const };
  const col = type === 'YARN' ? 'yarn_id' : type === 'FABRIC' ? 'fabric_id' : 'trim_id';
  const w = await queryOne<any>(
    `SELECT SUM(qty_in * rate) / NULLIF(SUM(qty_in), 0) AS rate FROM trx_stock_ledger
      WHERE company_id = ? AND ${col} = ? AND qty_in > 0 AND rate > 0 AND ref_type IN ('GRN','OPENING')`, [companyId, itemId]);
  if (numv(w?.rate) > 0) return { rate: numv(w.rate), basis: 'RECEIPT_AVG' as const };
  const tbl = type === 'YARN' ? 'mst_yarn' : type === 'FABRIC' ? 'mst_fabric' : 'mst_trim';
  const s = await queryOne<any>(`SELECT std_rate FROM ${tbl} WHERE id = ?`, [itemId]);
  return numv(s?.std_rate) > 0 ? { rate: numv(s.std_rate), basis: 'STD_RATE' as const } : { rate: 0, basis: 'NO_RATE' as const };
}

async function costSetting(companyId: number, key: string) {
  const r = await queryOne<any>(`SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`, [companyId, key]);
  const v = Number(String(r?.setting_value ?? '').trim());
  return r?.setting_value != null && String(r.setting_value).trim() !== '' && Number.isFinite(v) && v >= 0 ? v : null;
}

export async function buildOrderData(companyId: number, prodOrderId: number) {
  // A. Production order, its sales order and job (IO no)
  const order = await queryOne<any>(`
    SELECT po.*, st.style_code, st.style_name, st.season AS style_season, st.buyer_style_ref,
           b.id AS buyer_id, b.party_name AS buyer_name,
           so.so_no, so.io_no AS so_io_no, so.buyer_po_no, so.season AS so_season, so.currency_id AS so_currency_id,
           so.exchange_rate AS so_exchange_rate, u.unit_name
      FROM trx_production_order po
      LEFT JOIN mst_style st ON st.id = po.style_id
      LEFT JOIN trx_sales_order so ON so.id = po.so_id
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN mst_unit u ON u.id = po.unit_id
     WHERE po.id = ? AND po.company_id = ?
  `, [prodOrderId, companyId]);
  if (!order) throw NotFound('Production order not found');
  const ioNo: string | null = order.io_no || order.so_io_no || null;
  const styleId: number | null = order.style_id ?? null;

  // B. Standard: the style's pre-costing (approved preferred)
  const estimatedCosting = await queryOne<any>(`
    SELECT c.*, cur.code AS currency_code, cur.symbol AS currency_symbol, st.code AS status_code
      FROM trx_costing c
      LEFT JOIN cfg_currency cur ON cur.id = c.currency_id
      LEFT JOIN cfg_status st ON st.id = c.status_id
     WHERE c.style_id = ? AND c.company_id = ? AND c.is_deleted = 0
     ORDER BY (st.code = 'APPROVED') DESC, c.version DESC, c.id DESC LIMIT 1
  `, [styleId, companyId]);

  // C. Quantities from the bundle ledger of the job (split parents / merge sources excluded from cut qty)
  const q = ioNo ? await queryOne<any>(`
    SELECT COUNT(*) AS bundles,
           COALESCE(SUM(CASE WHEN cb.status <> 'SPLIT' AND NOT EXISTS
                (SELECT 1 FROM trx_bundle_merge_source ms WHERE ms.source_bundle_id = cb.id AND cb.status = 'CLOSED') THEN cb.qty END), 0) AS cut_qty,
           COALESCE(SUM(cb.sew_in_qty),0) AS sew_in, COALESCE(SUM(cb.sew_good_qty),0) AS sew_good,
           COALESCE(SUM(cb.sew_reject_qty),0) AS sew_rej, COALESCE(SUM(cb.fin_in_qty),0) AS fin_in,
           COALESCE(SUM(cb.fin_good_qty),0) AS fin_good, COALESCE(SUM(cb.fin_reject_qty),0) AS fin_rej,
           COALESCE(SUM(cb.qc_pass_qty),0) AS qc_pass, COALESCE(SUM(cb.qc_reject_qty),0) AS qc_rej,
           COALESCE(SUM(cb.packed_qty),0) AS packed,
           COALESCE(SUM(cb.cut_loss_qty + cb.sewn_loss_qty + cb.pack_loss_qty),0) AS losses
      FROM trx_cutting_bundle cb
     WHERE cb.company_id = ? AND cb.io_no = ? AND (? IS NULL OR cb.style_id = ?)
  `, [companyId, ioNo, styleId, styleId]) : null;
  const fg = await queryOne<any>(`
    SELECT COALESCE(SUM(total_qty),0) AS qty, COUNT(*) AS docs FROM trx_fg_receipt
     WHERE company_id = ? AND (prod_order_id = ? OR (? IS NOT NULL AND io_no = ? AND (? IS NULL OR style_id = ?)))
  `, [companyId, prodOrderId, ioNo, ioNo, styleId, styleId]);
  const rw = ioNo ? await queryOne<any>(`
    SELECT (SELECT COALESCE(SUM(rework_qty),0) FROM trx_sewing_output WHERE company_id = ? AND io_no = ?)
         + (SELECT COALESCE(SUM(rework_qty),0) FROM trx_final_qc WHERE company_id = ? AND io_no = ?) AS rework
  `, [companyId, ioNo, companyId, ioNo]) : null;

  const plannedQty = numv(order.planned_qty) || numv(order.order_qty);
  const cutQty = numv(q?.cut_qty);
  const sewGood = numv(q?.sew_good);
  const fgQty = numv(fg?.qty);
  const goodQty = fgQty || numv(q?.qc_pass) || numv(q?.fin_good) || sewGood;
  // FG can be received outside the bundle flow (e.g. older orders), so produced is never below good.
  const producedQty = Math.max(sewGood + numv(q?.sew_rej), goodQty);
  const rejectionQty = numv(q?.sew_rej) + numv(q?.fin_rej) + numv(q?.qc_rej) + numv(q?.losses);
  const reworkQty = numv(rw?.rework);

  // D. Fabric rolls issued to cutting for the job
  const fabricRolls = ioNo ? await query<any>(`
    SELECT fi.issue_no, fi.issue_date, fi.fabric_id, fb.fabric_code, fb.fabric_name,
           fir.lot_no, fir.roll_no, fir.issue_kg, fir.consumed_kg, fir.returned_kg,
           gl.rate AS grn_rate, g.grn_no, sup.party_name AS supplier_name,
           EXISTS (SELECT 1 FROM trx_process_receipt pr WHERE pr.grn_id = g.id) AS own_knitted
      FROM trx_fabric_issue fi
      JOIN trx_fabric_issue_roll fir ON fir.fabric_issue_id = fi.id
      LEFT JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id
      LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
      LEFT JOIN trx_grn g ON g.id = fr.grn_id
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_fabric fb ON fb.id = fi.fabric_id
     WHERE fi.company_id = ? AND fi.io_no = ? AND (fi.style_id IS NULL OR ? IS NULL OR fi.style_id = ?)
     ORDER BY fi.issue_date, fi.id, fir.id
  `, [companyId, ioNo, styleId, styleId]) : [];
  let stdRateUsed = 0;
  const fabricLines: any[] = [];
  for (const r of fabricRolls) {
    const kg = numv(r.consumed_kg) > 0 ? numv(r.consumed_kg) : Math.max(0, numv(r.issue_kg) - numv(r.returned_kg));
    let rate = numv(r.grn_rate);
    let basis = 'GRN';
    if (!rate && Number(r.own_knitted)) basis = 'OWN_KNITTING';
    else if (!rate) { const rr = await receiptRate(companyId, 'FABRIC', r.fabric_id); rate = rr.rate; basis = rr.basis; if (basis === 'STD_RATE') stdRateUsed++; }
    fabricLines.push({
      code: r.fabric_code, fabric_name: r.fabric_name, lot_no: r.lot_no, roll_no: r.roll_no,
      std_qty: null, issue_qty: r2(kg), rate: r2(rate), amount: r2(kg * rate), supplier_name: r.supplier_name,
      grn_no: r.grn_no, issue_no: r.issue_no, rate_basis: basis,
    });
  }
  const fabricAmt = fabricLines.reduce((a, l) => a + l.amount, 0);

  // E. Yarn issued to knitting / yarn processes of the job
  const yarnIssues = ioNo ? await query<any>(`
    SELECT pi.issue_no, pi.dc_no, pi.issue_date, pi.yarn_id, y.yarn_code, y.yarn_name, pi.lot_no, pi.issued_qty_kg,
           (SELECT gl.rate FROM trx_grn_line gl WHERE gl.yarn_id = pi.yarn_id AND gl.lot_no = pi.lot_no AND gl.rate > 0
             ORDER BY gl.id DESC LIMIT 1) AS lot_rate
      FROM trx_process_issue pi
      LEFT JOIN mst_yarn y ON y.id = pi.yarn_id
      LEFT JOIN trx_knitting_program kp ON pi.src_type = 'KNITTING_PROGRAM' AND kp.id = pi.src_id
      LEFT JOIN trx_yarn_process yp ON pi.src_type = 'YARN_PROCESS' AND yp.id = pi.src_id
     WHERE pi.company_id = ? AND COALESCE(kp.io_no, yp.io_no) = ?
     ORDER BY pi.issue_date, pi.id
  `, [companyId, ioNo]) : [];
  const yarnLines: any[] = [];
  for (const y of yarnIssues) {
    let rate = numv(y.lot_rate); let basis = 'LOT_GRN';
    if (!rate) { const rr = await receiptRate(companyId, 'YARN', y.yarn_id); rate = rr.rate; basis = rr.basis; if (basis === 'STD_RATE') stdRateUsed++; }
    const kg = numv(y.issued_qty_kg);
    yarnLines.push({ doc_no: y.dc_no || y.issue_no, item_name: y.yarn_name, item_code: y.yarn_code, lot_no: y.lot_no, qty: r2(kg), rate: r2(rate), amount: r2(kg * rate), rate_basis: basis });
  }
  const yarnAmt = yarnLines.reduce((a, l) => a + l.amount, 0);

  // F. Material issues against the production order (trims and any other materials)
  const matIssues = await query<any>(`
    SELECT mi.issue_no, mil.material_type, mil.issued_qty, mil.yarn_id, mil.fabric_id, mil.trim_id, u.code AS uom_code,
           COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name) AS item_name
      FROM trx_material_issue mi
      JOIN trx_material_issue_line mil ON mil.issue_id = mi.id
      LEFT JOIN mst_yarn y ON y.id = mil.yarn_id LEFT JOIN mst_fabric fb ON fb.id = mil.fabric_id
      LEFT JOIN mst_trim tr ON tr.id = mil.trim_id LEFT JOIN cfg_uom u ON u.id = mil.uom_id
     WHERE mi.company_id = ? AND mi.prod_order_id = ?
     ORDER BY mi.issue_date, mil.id
  `, [companyId, prodOrderId]);
  const trimLines: any[] = [];
  let otherMatAmt = 0;
  for (const m of matIssues) {
    const type = (m.material_type === 'YARN' || m.material_type === 'FABRIC' ? m.material_type : 'TRIM') as 'YARN' | 'FABRIC' | 'TRIM';
    const rr = await receiptRate(companyId, type, m.yarn_id ?? m.fabric_id ?? m.trim_id);
    if (rr.basis === 'STD_RATE') stdRateUsed++;
    const qty = numv(m.issued_qty); const amt = r2(qty * rr.rate);
    if (type === 'TRIM') {
      trimLines.push({ trim_name: m.item_name, uom: m.uom_code, std_qty: null, issue_qty: qty, return_qty: 0, net_qty: qty, rate: r2(rr.rate), actual_cost: amt, issue_no: m.issue_no, rate_basis: rr.basis });
    } else otherMatAmt += amt;
  }
  const trimAmt = trimLines.reduce((a, l) => a + l.actual_cost, 0);

  // G. Job work: process inwards on DCs of the job × DC rate
  const jw = await query<any>(`
    SELECT jc.id, jc.challan_no, jc.rate, ps.stage_code, ps.stage_name, ps.bill_include_mistake, v.party_name AS vendor_name,
           COALESCE(SUM(rl.received_qty),0) AS good, COALESCE(SUM(rl.rejected_qty),0) AS rej, COUNT(DISTINCT r.id) AS receipts
      FROM trx_jobwork_receipt r
      JOIN trx_jobwork_receipt_line rl ON rl.receipt_id = r.id
      LEFT JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
      JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
      LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      LEFT JOIN mst_party v ON v.id = jc.vendor_id
     WHERE r.company_id = ? AND ((? IS NOT NULL AND jl.io_no = ? AND (jl.style_id IS NULL OR ? IS NULL OR jl.style_id = ?)) OR jc.prod_order_id = ?)
     GROUP BY jc.id ORDER BY jc.challan_date, jc.id
  `, [companyId, ioNo, ioNo, styleId, styleId, prodOrderId]);
  let unpricedDcs = 0;
  const dcLine = (d: any) => {
    const billed = numv(d.good) + (numv(d.bill_include_mistake) ? numv(d.rej) : 0);
    if (d.rate == null) unpricedDcs++;
    return { ...d, billed, amount: r2(billed * numv(d.rate)) };
  };
  const dcs = jw.map(dcLine);
  const code = (d: any) => String(d.stage_code ?? '').toUpperCase();
  const sewDcs = dcs.filter((d) => SEW_STAGES.includes(code(d)));
  const finDcs = dcs.filter((d) => FIN_STAGES.includes(code(d)));
  const packDcs = dcs.filter((d) => PACK_STAGES.includes(code(d)));
  const embDcs = dcs.filter((d) => EMB_STAGES.includes(code(d)));
  const procDcs = dcs.filter((d) => ![...SEW_STAGES, ...FIN_STAGES, ...PACK_STAGES, ...EMB_STAGES].includes(code(d)));
  const sum = (ds: any[]) => ds.reduce((a, d) => a + d.amount, 0);

  // H. In-house rates (company settings) — never assumed
  const cutRate = await costSetting(companyId, 'COSTING_CUTTING_RATE_PER_PC');
  const sewRate = await costSetting(companyId, 'COSTING_SEWING_RATE_PER_PC');
  const ohRate = await costSetting(companyId, 'COSTING_OVERHEAD_PER_PC');
  const stitchDcGood = sewDcs.reduce((a, d) => a + numv(d.good), 0);
  const inHouseSewn = Math.max(0, sewGood - stitchDcGood);
  const cutAmt = cutRate != null ? r2(cutQty * cutRate) : 0;
  const inSewAmt = sewRate != null ? r2(inHouseSewn * sewRate) : 0;
  const ohAmt = ohRate != null ? r2(goodQty * ohRate) : 0;

  const heads: CostHead[] = [
    { key: 'fabric', label: 'Fabric', amount: r2(fabricAmt + yarnAmt + otherMatAmt),
      source: fabricLines.length || yarnLines.length || otherMatAmt ? 'TRANSACTIONS' : 'NO_DATA',
      note: fabricLines.length || yarnLines.length ? `${fabricLines.length} roll(s) issued to cutting, ${yarnLines.length} yarn issue(s)` : 'No fabric issue to cutting or yarn issue for this job',
      docs: fabricLines.length + yarnLines.length },
    { key: 'trims', label: 'Trims', amount: r2(trimAmt), source: trimLines.length ? 'TRANSACTIONS' : 'NO_DATA',
      note: trimLines.length ? `${trimLines.length} trim issue line(s)` : 'No material issue of trims against this production order', docs: trimLines.length },
    { key: 'process', label: 'Process (print / emb / wash …)', amount: r2(sum(embDcs) + sum(procDcs)),
      source: embDcs.length + procDcs.length ? 'TRANSACTIONS' : 'NO_DATA',
      note: embDcs.length + procDcs.length ? `${embDcs.length + procDcs.length} process DC(s) received` : 'No printing / embroidery / washing DC received for this job', docs: embDcs.length + procDcs.length },
    { key: 'cutting', label: 'Cutting', amount: cutAmt, source: cutRate != null ? 'RATE_SETTING' : 'NO_DATA',
      note: cutRate != null ? `${fmtQty(cutQty)} cut PCS × ₹${cutRate}/PC (COSTING_CUTTING_RATE_PER_PC)` : 'Set COSTING_CUTTING_RATE_PER_PC to cost in-house cutting', docs: 0 },
    { key: 'sewing', label: 'Sewing', amount: r2(sum(sewDcs) + inSewAmt),
      source: sewDcs.length ? 'TRANSACTIONS' : sewRate != null ? 'RATE_SETTING' : 'NO_DATA',
      note: [sewDcs.length ? `${sewDcs.length} stitching DC(s)` : '', sewRate != null ? `${fmtQty(inHouseSewn)} in-house PCS × ₹${sewRate}/PC` : inHouseSewn ? `${fmtQty(inHouseSewn)} in-house PCS not costed — set COSTING_SEWING_RATE_PER_PC` : '']
        .filter(Boolean).join(' · ') || 'No stitching DC received and no in-house sewing rate', docs: sewDcs.length },
    { key: 'finishing', label: 'Finishing / ironing', amount: r2(sum(finDcs)), source: finDcs.length ? 'TRANSACTIONS' : 'NO_DATA',
      note: finDcs.length ? `${finDcs.length} ironing / finishing DC(s)` : 'No ironing / finishing DC received for this job', docs: finDcs.length },
    { key: 'packing', label: 'Packing', amount: r2(sum(packDcs)), source: packDcs.length ? 'TRANSACTIONS' : 'NO_DATA',
      note: packDcs.length ? `${packDcs.length} packing DC(s)` : 'No packing DC received (packing materials are under Trims)', docs: packDcs.length },
    { key: 'overhead', label: 'Overhead', amount: ohAmt, source: ohRate != null ? 'RATE_SETTING' : 'NO_DATA',
      note: ohRate != null ? `${fmtQty(goodQty)} good PCS × ₹${ohRate}/PC (COSTING_OVERHEAD_PER_PC)` : 'Set COSTING_OVERHEAD_PER_PC to allocate factory overhead', docs: 0 },
  ];
  const H = Object.fromEntries(heads.map((h) => [h.key, h.amount])) as Record<string, number>;

  const materialCost = r2(H.fabric + H.trims);
  const labourCost = r2(H.cutting + H.sewing);
  const jobworkCost = r2(sum(embDcs));
  const processCost = r2(sum(procDcs));
  const packingCost = r2(H.finishing + H.packing);
  const overheadCost = H.overhead;
  const machineCost = 0; // removed from the sheet (client review) — column kept at 0
  const totalActualCost = r2(materialCost + labourCost + jobworkCost + processCost + packingCost + overheadCost);
  const actualCostPerPiece = producedQty > 0 ? totalActualCost / producedQty : 0;
  const costPerGoodPiece = goodQty > 0 ? totalActualCost / goodQty : 0;

  // I. Standard in INR
  let fx: number | null = null;
  let fxBasis = 'NONE';
  if (estimatedCosting) {
    if (!estimatedCosting.currency_code || estimatedCosting.currency_code === 'INR') { fx = 1; fxBasis = 'INR'; }
    else if (numv(order.so_currency_id) === numv(estimatedCosting.currency_id) && numv(order.so_exchange_rate) > 1) {
      fx = numv(order.so_exchange_rate); fxBasis = `Sales order ${order.so_no}`;
    } else {
      const inr = await queryOne<any>(`SELECT id FROM cfg_currency WHERE code = 'INR' LIMIT 1`);
      const xr = inr ? await queryOne<any>(
        `SELECT rate, rate_date FROM trx_exchange_rate WHERE from_currency = ? AND to_currency = ? ORDER BY rate_date DESC, id DESC LIMIT 1`,
        [estimatedCosting.currency_id, inr.id]) : null;
      if (numv(xr?.rate) > 0) { fx = numv(xr.rate); fxBasis = `Exchange rate of ${String(xr.rate_date).slice(0, 10)}`; }
    }
  }
  const stdAvailable = !!estimatedCosting && fx != null;
  const ec = estimatedCosting;
  const toInr = (v: number) => (fx != null ? v * fx : 0);
  const stdTotalPc = ec ? toInr(numv(ec.total_cost)) : 0;
  const stdPc = {
    fabric: ec ? toInr(numv(ec.fabric_cost) + numv(ec.yarn_cost) + numv(ec.knitting_cost) + numv(ec.dyeing_cost)) : 0,
    trims: ec ? toInr(numv(ec.trim_cost)) : 0,
    process: ec ? toInr(numv(ec.washing_cost) + numv(ec.printing_cost) + numv(ec.embroidery_cost)) : 0,
    cutting: ec ? toInr(numv(ec.cutting_cost)) : 0,
    sewing: ec ? toInr(numv(ec.stitching_cost)) : 0,
    finishing: ec ? toInr(numv(ec.finishing_cost)) : 0,
    packing: ec ? toInr(numv(ec.packing_cost)) : 0,
    overhead: 0,
  } as Record<string, number>;
  stdPc.overhead = Math.max(0, stdTotalPc - Object.entries(stdPc).filter(([k]) => k !== 'overhead').reduce((a, [, v]) => a + v, 0));

  const estimatedCostPerPiece = stdAvailable ? stdTotalPc : 0;
  const perPcBase = goodQty || producedQty;
  const totalEstimatedCost = estimatedCostPerPiece * perPcBase;
  const varianceAmount = stdAvailable ? totalActualCost - totalEstimatedCost : 0;
  const variancePct = stdAvailable && totalEstimatedCost > 0 ? (varianceAmount / totalEstimatedCost) * 100 : 0;

  // Variance per good piece and head (standard in INR)
  const varianceRows: any[] = heads.map((h) => {
    const actual_pc = perPcBase > 0 ? r2(h.amount / perPcBase) : 0;
    const standard_pc = stdAvailable ? r2(stdPc[h.key] ?? 0) : null;
    const variance = standard_pc != null ? r2(actual_pc - standard_pc) : null;
    const variance_pct = standard_pc ? r2(((variance as number) / standard_pc) * 100) : null;
    return { cost_head: h.label, key: h.key, standard_pc, actual_pc, variance, variance_pct, source: h.source, note: h.note };
  });
  const totAct = r2(varianceRows.reduce((a, r) => a + r.actual_pc, 0));
  const totStd = stdAvailable ? r2(varianceRows.reduce((a, r) => a + (r.standard_pc ?? 0), 0)) : null;
  varianceRows.push({
    cost_head: 'TOTAL', key: 'total', standard_pc: totStd, actual_pc: totAct,
    variance: totStd != null ? r2(totAct - totStd) : null,
    variance_pct: totStd ? r2(((totAct - totStd) / totStd) * 100) : null, source: null, note: null,
  });

  const breakdownHeads = [
    { head: 'Material (Fabric, Yarn, Trims)', keys: ['fabric', 'trims'], actual: materialCost },
    { head: 'Direct Sewing & Cutting Labour', keys: ['cutting', 'sewing'], actual: labourCost },
    { head: 'Outsourced Job Work (Printing/Emb)', keys: [], actual: jobworkCost },
    { head: 'Washing & Other Processes', keys: [], actual: processCost },
    { head: 'Finishing, Ironing & Packing', keys: ['finishing', 'packing'], actual: packingCost },
    { head: 'Factory Overheads', keys: ['overhead'], actual: overheadCost },
  ].map((h, i) => {
    const stdKeys = i === 2 ? [] : h.keys;
    let estimatedPc = stdKeys.reduce((a, k) => a + (stdPc[k] ?? 0), 0);
    if (i === 2) estimatedPc = ec ? toInr(numv(ec.printing_cost) + numv(ec.embroidery_cost)) : 0;
    if (i === 3) estimatedPc = ec ? toInr(numv(ec.washing_cost)) : 0;
    const estimated = stdAvailable ? estimatedPc * perPcBase : 0;
    const variance = stdAvailable ? h.actual - estimated : 0;
    return { head: h.head, estimated, actual: h.actual, variance, variance_pct: estimated > 0 ? (variance / estimated) * 100 : 0 };
  });

  // Stage-wise quantities from the bundle ledger
  const stageWip = [
    { stage: 'Cutting', input: plannedQty, output: cutQty, rejected: 0, wip: Math.max(0, plannedQty - cutQty) },
    { stage: 'Sewing / Stitching', input: numv(q?.sew_in), output: sewGood, rejected: numv(q?.sew_rej), wip: Math.max(0, numv(q?.sew_in) - sewGood - numv(q?.sew_rej)) },
    { stage: 'Finishing / Ironing', input: numv(q?.fin_in), output: numv(q?.fin_good), rejected: numv(q?.fin_rej), wip: Math.max(0, numv(q?.fin_in) - numv(q?.fin_good) - numv(q?.fin_rej)) },
    { stage: 'Final QC', input: numv(q?.fin_good), output: numv(q?.qc_pass), rejected: numv(q?.qc_rej), wip: Math.max(0, numv(q?.fin_good) - numv(q?.qc_pass) - numv(q?.qc_rej)) },
    { stage: 'Packing', input: numv(q?.qc_pass), output: numv(q?.packed), rejected: 0, wip: Math.max(0, numv(q?.qc_pass) - numv(q?.packed)) },
  ];

  const dcTab = (ds: any[]) => ds.map((d) => ({
    component: `${d.stage_name ?? 'Job work'} DC ${d.challan_no} — ${d.vendor_name ?? ''} (${fmtQty(d.billed)} PCS × ₹${numv(d.rate).toFixed(2)})`,
    actual_cost: d.amount,
  }));

  return ({
      order: {
        id: order.id, po_prod_no: order.po_prod_no, prod_date: order.prod_date, style_id: order.style_id,
        style_code: order.style_code, style_name: order.style_name, buyer_style_ref: order.buyer_style_ref ?? null,
        buyer_id: order.buyer_id, buyer_name: order.buyer_name, buyer_po_no: order.buyer_po_no, so_no: order.so_no,
        io_no: ioNo, season: order.so_season || order.style_season || null, unit_name: order.unit_name ?? null,
        order_qty: order.order_qty, planned_qty: plannedQty, produced_qty: producedQty, good_qty: goodQty,
        rejection_qty: rejectionQty, rework_qty: reworkQty, cost_per_good_piece: r2(costPerGoodPiece),
        currency_code: 'INR', merchandiser_costing_no: estimatedCosting?.costing_no ?? null,
      },
      summary: {
        planned_qty: plannedQty, produced_qty: producedQty, good_qty: goodQty, rejection_qty: rejectionQty, rework_qty: reworkQty,
        material_cost: materialCost, labour_cost: labourCost, machine_cost: machineCost, jobwork_cost: jobworkCost,
        process_cost: processCost, overhead_cost: overheadCost, packing_cost: packingCost,
        total_actual_cost: totalActualCost, actual_cost_per_piece: actualCostPerPiece, cost_per_good_piece: costPerGoodPiece,
        estimated_cost_per_piece: estimatedCostPerPiece, total_estimated_cost: totalEstimatedCost,
        variance_amount: varianceAmount, variance_pct: variancePct,
      },
      heads,
      quality: { std_rate_valuations: stdRateUsed, unpriced_dcs: unpricedDcs, has_job: !!ioNo },
      tabs: {
        fabric: fabricLines,
        yarn: yarnLines,
        trims: trimLines,
        process: [...embDcs, ...procDcs].map((d) => ({
          process_name: `${d.stage_name} — DC ${d.challan_no} (${d.vendor_name ?? ''})`, part_name: null,
          input_qty: d.billed, output_qty: numv(d.good), loss_qty: numv(d.rej), rate: numv(d.rate), actual_cost: d.amount,
        })),
        cutting: cutRate != null ? [{ component: `In-house cutting — ${fmtQty(cutQty)} PCS × ₹${cutRate}`, actual_cost: cutAmt }] : [],
        sewing: [
          ...sewDcs.map((d) => ({ operation: `Stitching DC ${d.challan_no} — ${d.vendor_name ?? ''}`, sam: null, rate_per_min: null, cost_per_pc: numv(d.rate), total: d.amount })),
          ...(sewRate != null && inHouseSewn ? [{ operation: 'In-house sewing', sam: null, rate_per_min: null, cost_per_pc: sewRate, total: inSewAmt }] : []),
        ],
        finishing: dcTab(finDcs),
        packing: packDcs.map((d) => ({ item_name: `Packing DC ${d.challan_no} — ${d.vendor_name ?? ''}`, qty: d.billed, rate: numv(d.rate), amount: d.amount })),
        labour: [],
        machine: [],
        overhead: ohRate != null ? [{ overhead_head: 'Factory overhead (COSTING_OVERHEAD_PER_PC)', allocation_basis: 'PER_GOOD_PIECE', rate: ohRate, amount: ohAmt }] : [],
        variance: varianceRows,
      },
      breakdownHeads,
      standard: {
        costing_id: estimatedCosting?.id ?? null,
        costing_no: estimatedCosting?.costing_no ?? null,
        approved: estimatedCosting?.status_code === 'APPROVED',
        available: stdAvailable,
        cost_per_piece: estimatedCostPerPiece,
        cost_per_piece_original: estimatedCosting ? numv(estimatedCosting.total_cost) : 0,
        fob_price: stdAvailable ? toInr(numv(estimatedCosting.fob_price)) : 0,
        fob_price_original: estimatedCosting ? numv(estimatedCosting.fob_price) : 0,
        original_currency_code: estimatedCosting?.currency_code || null,
        currency_code: 'INR',
        fx_rate: fx,
        fx_basis: fxBasis,
      },
      stageWip,
      sources: { fabric_rolls: fabricLines.length, yarn_issues: yarnLines.length, material_issue_lines: matIssues.length, dcs, fg_receipts: numv(fg?.docs) },
  });
}

costingRouter.get('/production-costs/order-data/:prodOrderId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ data: await buildOrderData(req.user!.companyId, Number(req.params.prodOrderId)) });
}));

function fmtQty(v: number) { return Number(v || 0).toLocaleString('en-IN'); }


/**
 * 2. POST /api/production-costs/calculate-and-save
 * Saves or updates an automatic actual production costing sheet with all lines and snapshot data.
 */
costingRouter.post('/production-costs/calculate-and-save', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  const result = await transaction(async (tx) => {
    let costId = body.id ? Number(body.id) : null;
    let costNo = body.cost_no;

    if (!costId) {
      if (!costNo) {
        costNo = await nextDocNumber(tx, companyId, 'PROD_COST');
      }
      const [insRes] = await tx.execute(`
        INSERT INTO trx_production_cost (
          company_id, cost_no, cost_date, prod_order_id, style_id, buyer_id, unit_id,
          io_id, sales_order_id, merchandiser_costing_id,
          order_qty, planned_qty, produced_qty, good_qty, rejection_qty, rework_qty,
          costing_period, costing_type, version,
          material_cost, labour_cost, machine_cost, jobwork_cost, process_cost,
          overhead_cost, packing_cost, total_cost, cost_per_piece, cost_per_good_piece,
          estimated_cost, variance, variance_pct, status, remarks, data_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        companyId, costNo, body.cost_date || new Date().toISOString().slice(0, 10),
        body.prod_order_id, body.style_id || null, body.buyer_id || null, body.unit_id || null,
        body.io_id || null, body.sales_order_id || null, body.merchandiser_costing_id || null,
        body.order_qty || 0, body.planned_qty || 0, body.produced_qty || 0,
        body.good_qty || body.produced_qty || 0, body.rejection_qty || 0, body.rework_qty || 0,
        body.costing_period || 'Current', body.costing_type || 'ACTUAL', body.version || 1,
        body.material_cost || 0, body.labour_cost || 0, body.machine_cost || 0,
        body.jobwork_cost || 0, body.process_cost || 0, body.overhead_cost || 0,
        body.packing_cost || 0, body.total_cost || 0, body.cost_per_piece || 0,
        body.cost_per_good_piece || body.cost_per_piece || 0,
        body.estimated_cost || 0, body.variance || 0, body.variance_pct || 0,
        body.status || 'CALCULATED', body.remarks || null,
        body.data_json ? JSON.stringify(body.data_json) : null, userId,
      ]);
      costId = (insRes as any).insertId;
    } else {
      await tx.execute(`
        UPDATE trx_production_cost SET
          cost_date = ?, prod_order_id = ?, style_id = ?, buyer_id = ?, unit_id = ?,
          io_id = ?, sales_order_id = ?, merchandiser_costing_id = ?,
          order_qty = ?, planned_qty = ?, produced_qty = ?, good_qty = ?, rejection_qty = ?, rework_qty = ?,
          costing_period = ?, costing_type = ?, version = ?,
          material_cost = ?, labour_cost = ?, machine_cost = ?, jobwork_cost = ?,
          process_cost = ?, overhead_cost = ?, packing_cost = ?, total_cost = ?,
          cost_per_piece = ?, cost_per_good_piece = ?, estimated_cost = ?,
          variance = ?, variance_pct = ?, status = ?, remarks = ?, data_json = ?
        WHERE id = ? AND company_id = ?
      `, [
        body.cost_date || new Date().toISOString().slice(0, 10),
        body.prod_order_id, body.style_id || null, body.buyer_id || null, body.unit_id || null,
        body.io_id || null, body.sales_order_id || null, body.merchandiser_costing_id || null,
        body.order_qty || 0, body.planned_qty || 0, body.produced_qty || 0,
        body.good_qty || body.produced_qty || 0, body.rejection_qty || 0, body.rework_qty || 0,
        body.costing_period || 'Current', body.costing_type || 'ACTUAL', body.version || 1,
        body.material_cost || 0, body.labour_cost || 0, body.machine_cost || 0,
        body.jobwork_cost || 0, body.process_cost || 0, body.overhead_cost || 0,
        body.packing_cost || 0, body.total_cost || 0, body.cost_per_piece || 0,
        body.cost_per_good_piece || body.cost_per_piece || 0,
        body.estimated_cost || 0, body.variance || 0, body.variance_pct || 0,
        body.status || 'CALCULATED', body.remarks || null,
        body.data_json ? JSON.stringify(body.data_json) : null,
        costId, companyId,
      ]);
      await tx.execute(`DELETE FROM trx_production_cost_line WHERE cost_id = ?`, [costId]);
      await tx.execute(`DELETE FROM trx_production_costing_material WHERE cost_id = ?`, [costId]);
      await tx.execute(`DELETE FROM trx_production_costing_process WHERE cost_id = ?`, [costId]);
      await tx.execute(`DELETE FROM trx_production_costing_labour WHERE cost_id = ?`, [costId]);
      await tx.execute(`DELETE FROM trx_production_costing_machine WHERE cost_id = ?`, [costId]);
      await tx.execute(`DELETE FROM trx_production_costing_overhead WHERE cost_id = ?`, [costId]);
    }

    // Insert generic lines
    if (Array.isArray(body.lines) && body.lines.length > 0) {
      for (const line of body.lines) {
        await tx.execute(`
          INSERT INTO trx_production_cost_line (
            cost_id, cost_head, cost_category, stage_name, item_description,
            ref_type, ref_id, ref_doc_no, quantity, uom_id, rate, amount, remarks
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          costId, line.cost_head || 'Cost Head', line.cost_category || 'OTHER',
          line.stage_name || null, line.item_description || null,
          line.ref_type || null, line.ref_id || null, line.ref_doc_no || null,
          line.quantity || 0, line.uom_id || null, line.rate || 0, line.amount || 0,
          line.remarks || null,
        ]);
      }
    }

    // Insert granular sub-tables from data_json or body.tabs if available
    const dj = body.data_json || {};
    const tabs = dj.tabs || body.tabs || {};

    // 1. Material (Fabric & Trims)
    if (Array.isArray(tabs.fabric)) {
      for (const f of tabs.fabric) {
        await tx.execute(`
          INSERT INTO trx_production_costing_material (
            cost_id, material_type, item_code, item_name, lot_no, roll_no,
            planned_qty, issue_qty, return_qty, net_qty, uom_code, rate, amount, supplier_name, grn_no
          ) VALUES (?, 'FABRIC', ?, ?, ?, ?, ?, ?, 0, ?, 'KG', ?, ?, ?, ?)
        `, [costId, f.code || 'FAB-01', f.fabric_name || 'Fabric', f.lot_no || null, f.roll_no || null, f.std_qty || 0, f.issue_qty || 0, f.issue_qty || 0, f.rate || 0, f.amount || 0, f.supplier_name || null, f.grn_no || null]);
      }
    }
    if (Array.isArray(tabs.trims)) {
      for (const t of tabs.trims) {
        await tx.execute(`
          INSERT INTO trx_production_costing_material (
            cost_id, material_type, item_name, planned_qty, issue_qty, return_qty, net_qty, uom_code, rate, amount
          ) VALUES (?, 'TRIM', ?, ?, ?, ?, ?, ?, ?, ?)
        `, [costId, t.trim_name || 'Trim', t.std_qty || 0, t.issue_qty || 0, t.return_qty || 0, t.net_qty || 0, t.uom || 'PCS', t.rate || 0, t.actual_cost || 0]);
      }
    }

    // 2. Process
    const processList = tabs.process || tabs.processes;
    if (Array.isArray(processList)) {
      for (const p of processList) {
        const amt = p.actual_cost ?? p.amount ?? p.cost ?? (Number(p.rate || p.rate_per_piece || 0) * Number(p.pieces || p.output_qty || 0));
        await tx.execute(`
          INSERT INTO trx_production_costing_process (
            cost_id, process_name, part_name, input_qty, output_qty, loss_qty, rate, amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [costId, p.process_name || 'Process', p.part_name || 'TOP', p.input_qty || p.pieces || 0, p.output_qty || p.pieces || 0, p.loss_qty || 0, p.rate || p.rate_per_piece || 0, amt]);
      }
    }

    // 3. Labour
    if (Array.isArray(tabs.labour)) {
      for (const l of tabs.labour) {
        const amt = l.amount ?? l.cost ?? (Number(l.piece_rate || 0) * Number(l.pieces_completed || 0));
        await tx.execute(`
          INSERT INTO trx_production_costing_labour (
            cost_id, department_name, part_name, labour_type, piece_rate, pieces_completed, hours, rate_per_hour, amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [costId, l.department_name || l.operation_name || 'Floor', l.part_name || 'TOP', l.labour_type || 'DIRECT', l.piece_rate || 0, l.pieces_completed || 0, l.hours || 0, l.rate_per_hour || 0, amt]);
      }
    }

    // 4. Machine
    if (Array.isArray(tabs.machine)) {
      for (const m of tabs.machine) {
        await tx.execute(`
          INSERT INTO trx_production_costing_machine (
            cost_id, machine_name, department_name, machine_hours, hourly_rate, electricity_cost, maintenance_cost, depreciation_cost, total_cost
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [costId, m.machine_name || 'Machine', m.department_name || 'Floor', m.machine_hours || 0, m.hourly_rate || 0, m.electricity_cost || 0, m.maintenance_cost || 0, m.depreciation_cost || 0, m.total_cost || 0]);
      }
    }

    // 5. Overhead
    if (Array.isArray(tabs.overhead)) {
      for (const o of tabs.overhead) {
        await tx.execute(`
          INSERT INTO trx_production_costing_overhead (
            cost_id, overhead_head, allocation_basis, rate, amount
          ) VALUES (?, ?, ?, ?, ?)
        `, [costId, o.overhead_head || 'Overhead', o.allocation_basis || 'PER_PIECE', o.rate || 0, o.amount || 0]);
      }
    }

    return txQueryOne(tx, `SELECT * FROM trx_production_cost WHERE id = ?`, [costId]);
  });

  await audit(req, 'trx_production_cost', (result as any).id, body.id ? 'UPDATE' : 'INSERT', undefined, result);
  res.json({ data: result });
}));

/**
 * Spec Section 24 APIs: /production-costing
 */

// POST /api/production-costing (Create / Save)
costingRouter.post('/production-costing', requirePermission('PRODUCTION.CREATE'), ah(async (req, res, next) => {
  // Delegate directly to calculate-and-save handler logic
  (costingRouter as any).handle(Object.assign(req, { url: '/production-costs/calculate-and-save' }), res, next);
}));

// GET /api/production-costing/:id
costingRouter.get('/production-costing/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`
    SELECT c.*,
           po.po_prod_no,
           st.style_code, st.style_name, st.buyer_style_ref,
           b.party_name AS buyer_name,
           so.so_no, so.io_no, so.buyer_po_no,
           u.unit_name,
           appr.full_name AS approved_by_name
      FROM trx_production_cost c
      LEFT JOIN trx_production_order po ON po.id = c.prod_order_id
      LEFT JOIN mst_style st ON st.id = c.style_id
      LEFT JOIN mst_party b ON b.id = c.buyer_id
      LEFT JOIN trx_sales_order so ON so.id = po.so_id
      LEFT JOIN mst_unit u ON u.id = c.unit_id
      LEFT JOIN mst_user appr ON appr.id = c.approved_by
     WHERE c.id = ? AND c.company_id = ?
  `, [id, companyId]);

  if (!header) throw NotFound('Production costing record not found');

  const materials = await query<any>(`SELECT * FROM trx_production_costing_material WHERE cost_id = ? ORDER BY id ASC`, [id]);
  const processes = await query<any>(`SELECT * FROM trx_production_costing_process WHERE cost_id = ? ORDER BY id ASC`, [id]);
  const labour = await query<any>(`SELECT * FROM trx_production_costing_labour WHERE cost_id = ? ORDER BY id ASC`, [id]);
  const machines = await query<any>(`SELECT * FROM trx_production_costing_machine WHERE cost_id = ? ORDER BY id ASC`, [id]);
  const overheads = await query<any>(`SELECT * FROM trx_production_costing_overhead WHERE cost_id = ? ORDER BY id ASC`, [id]);
  const lines = await query<any>(`SELECT * FROM trx_production_cost_line WHERE cost_id = ? ORDER BY id ASC`, [id]);

  res.json({
    data: {
      ...header,
      sub_tables: {
        materials,
        processes,
        labour,
        machines,
        overheads,
        lines,
      },
    },
  });
}));

// POST /api/production-costing/:id/submit
costingRouter.post('/production-costing/:id/submit', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  await query(`UPDATE trx_production_cost SET status = 'SUBMITTED' WHERE id = ? AND company_id = ?`, [id, companyId]);
  res.json({ message: 'Production costing successfully submitted for review.' });
}));

// POST /api/production-costing/:id/approve
costingRouter.post('/production-costing/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);

  const existing = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!existing) throw NotFound('Costing record not found');
  if (existing.status === 'APPROVED' || existing.status === 'LOCKED') {
    throw BadRequest('Costing is already approved and locked.');
  }

  await query(`
    UPDATE trx_production_cost
       SET status = 'APPROVED', approved_by = ?, approved_at = NOW(), finalized_by = ?, finalized_at = NOW()
     WHERE id = ? AND company_id = ?
  `, [userId, userId, id, companyId]);

  res.json({ message: 'Production costing approved and locked.' });
}));

// POST /api/production-costing/:id/calculate or /recalculate (Spec §24)
const handleRecalculateProductionCosting = ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const cost = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!cost) throw NotFound('Costing record not found');
  if (cost.status === 'APPROVED' || cost.status === 'LOCKED') {
    throw BadRequest('Approved costing cannot be modified. Create a revision first.');
  }

  const pId = cost.prod_order_id;
  if (pId) {
    // Same transaction-driven figures as the cost sheet (buildOrderData) — nothing assumed.
    const d = await buildOrderData(companyId, pId);
    const sm = d.summary;
    await query(`
      UPDATE trx_production_cost
         SET produced_qty = ?, rejection_qty = ?, rework_qty = ?, good_qty = ?,
             material_cost = ?, labour_cost = ?, machine_cost = 0, jobwork_cost = ?, process_cost = ?,
             overhead_cost = ?, packing_cost = ?, total_cost = ?, cost_per_piece = ?, cost_per_good_piece = ?,
             estimated_cost = ?, variance = ?, variance_pct = ?
       WHERE id = ? AND company_id = ?
    `, [sm.produced_qty, sm.rejection_qty, sm.rework_qty, sm.good_qty,
        sm.material_cost, sm.labour_cost, sm.jobwork_cost, sm.process_cost, sm.overhead_cost, sm.packing_cost,
        sm.total_actual_cost, Number(sm.actual_cost_per_piece.toFixed(4)), Number(sm.cost_per_good_piece.toFixed(4)),
        d.standard.available ? sm.total_estimated_cost : 0, d.standard.available ? sm.variance_amount : 0,
        d.standard.available ? Number(sm.variance_pct.toFixed(2)) : 0, id, companyId]);
  }

  const updated = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ?`, [id]);
  res.json({ data: updated, message: 'Production costing recalculated successfully.' });
});

costingRouter.post('/production-costing/:id/calculate', requirePermission('PRODUCTION.CREATE'), handleRecalculateProductionCosting);
costingRouter.post('/production-costing/:id/recalculate', requirePermission('PRODUCTION.CREATE'), handleRecalculateProductionCosting);

// POST /api/production-costing/:id/revise (Spec §24)
costingRouter.post('/production-costing/:id/revise', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);
  const { reason } = req.body;

  const cost = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!cost) throw NotFound('Costing record not found');

  const newCostingNo = `${cost.costing_no}-REV`;

  const [ins] = await query<any>(`
    INSERT INTO trx_production_cost (
      company_id, prod_order_id, costing_no, cost_date, produced_qty, good_qty, rejection_qty,
      rework_qty, estimated_cost, total_cost, cost_per_piece, cost_per_good_piece, currency_id,
      sales_order_id, io_id, merchandiser_costing_id, data_json, status, remarks, created_by
    ) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)
  `, [
    companyId, cost.prod_order_id, newCostingNo, cost.produced_qty, cost.good_qty, cost.rejection_qty,
    cost.rework_qty, cost.estimated_cost, cost.total_cost, cost.cost_per_piece, cost.cost_per_good_piece,
    cost.currency_id, cost.sales_order_id, cost.io_id, cost.merchandiser_costing_id, cost.data_json,
    reason ? `Revision of ${cost.costing_no}: ${reason}` : `Revision of ${cost.costing_no}`, userId
  ]);

  const newId = (ins as any).insertId;

  // Copy sub-tables to the new revision
  const subTables = [
    { table: 'trx_production_costing_material', cols: 'item_type, item_id, description, uom_id, required_qty, standard_rate, standard_amount, issued_qty, returned_qty, actual_qty, actual_rate, actual_amount, variance_amount, variance_pct, remarks' },
    { table: 'trx_production_costing_process', cols: 'process_stage_id, process_name, operation_type, vendor_id, standard_rate, standard_amount, input_qty, output_qty, loss_qty, loss_pct, actual_rate, actual_amount, variance_amount, variance_pct, remarks' },
    { table: 'trx_production_costing_labour', cols: 'cost_center, department, operator_count, standard_sam, standard_rate_per_sam, standard_amount, actual_hours, actual_manpower, actual_amount, piece_rate, pieces_completed, piece_rate_amount, variance_amount, remarks' },
    { table: 'trx_production_costing_machine', cols: 'machine_id, machine_name, machine_type, run_hours, power_units, power_cost, depreciation_cost, maintenance_cost, standard_amount, actual_amount, variance_amount, remarks' },
    { table: 'trx_production_costing_overhead', cols: 'overhead_type, allocation_method, allocation_basis_value, standard_rate, standard_amount, actual_amount, variance_amount, remarks' },
  ];

  for (const st of subTables) {
    try {
      await query(`
        INSERT INTO ${st.table} (costing_id, ${st.cols})
        SELECT ${newId}, ${st.cols} FROM ${st.table} WHERE costing_id = ?
      `, [id]);
    } catch (e) {}
  }

  res.json({ id: newId, message: `New revision ${newCostingNo} created successfully in DRAFT state.` });
}));

// GET /api/production-costing/:id/variance
costingRouter.get('/production-costing/:id/variance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cost = await queryOne<any>(`SELECT data_json, estimated_cost, cost_per_piece, total_cost, produced_qty FROM trx_production_cost WHERE id = ?`, [id]);
  if (!cost) throw NotFound('Costing not found');

  let variance = [];
  if (cost.data_json) {
    try {
      const parsed = typeof cost.data_json === 'string' ? JSON.parse(cost.data_json) : cost.data_json;
      if (parsed.tabs?.variance) variance = parsed.tabs.variance;
    } catch (e) {}
  }
  res.json({ data: variance });
}));

// GET /api/production-costing/:id/drilldown (Traceability per Spec §27)
costingRouter.get('/production-costing/:id/drilldown', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const cost = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!cost) throw NotFound('Costing not found');

  const pId = cost.prod_order_id;

  // 1. Fabric issue → roll → lot → GRN → supplier (real rolls of the job, see buildOrderData)
  const od = pId ? await buildOrderData(companyId, pId) : null;
  const fabricTrace = (od?.tabs.fabric ?? []).map((f: any) => ({
    issue_no: f.issue_no, issued_qty: f.issue_qty, fabric_name: f.fabric_name, fabric_code: f.code,
    supplier_name: f.supplier_name, grn_no: f.grn_no, lot_no: f.lot_no, roll_no: f.roll_no, rate: f.rate, rate_basis: f.rate_basis,
  }));

  // 2. Process Order / Challan / Input / Output
  const processTrace = await query<any>(`
    SELECT jc.challan_no, jc.challan_date, jc.total_qty AS input_qty,
           jr.receipt_no, jr.receipt_date, jr.received_qty AS output_qty,
           ps.stage_name, v.party_name AS vendor_name
      FROM trx_jobwork_challan jc
      LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      LEFT JOIN mst_party v ON v.id = jc.vendor_id
      LEFT JOIN trx_jobwork_receipt jr ON jr.challan_id = jc.id
     WHERE jc.prod_order_id = ? AND jc.company_id = ?
  `, [pId, companyId]);

  // 3. Production workflow from the bundle ledger (same figures as the cost sheet)
  const stage = (name: string) => (od?.stageWip ?? []).filter((w: any) => w.stage.startsWith(name));
  const cuttingTrace = stage('Cutting');
  const sewingTrace = stage('Sewing');
  const finishingTrace = [...stage('Finishing'), ...stage('Final QC')];
  const packingTrace = stage('Packing');

  res.json({
    data: {
      fabric: fabricTrace,
      process: processTrace,
      cutting: cuttingTrace,
      sewing: sewingTrace,
      finishing: finishingTrace,
      packing: packingTrace,
    },
  });
}));

/**
 * 3. POST /api/production-costs/:id/finalize
 * Freezes the costing sheet and marks it FINALIZED / LOCKED.
 */
costingRouter.post('/production-costs/:id/finalize', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const costId = Number(req.params.id);

  const existing = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [costId, companyId]);
  if (!existing) throw NotFound('Costing record not found');
  if (existing.status === 'FINALIZED' || existing.status === 'LOCKED') {
    throw BadRequest('Costing is already finalized and locked.');
  }

  await query(`
    UPDATE trx_production_cost
       SET status = 'FINALIZED', finalized_by = ?, finalized_at = NOW()
     WHERE id = ? AND company_id = ?
  `, [userId, costId, companyId]);

  const updated = await queryOne(`SELECT * FROM trx_production_cost WHERE id = ?`, [costId]);
  await audit(req, 'trx_production_cost', costId, 'UPDATE', existing, updated);
  res.json({ data: updated, message: 'Production costing successfully finalized and locked against direct edits.' });
}));

/**
 * 4. POST /api/production-costs/:id/revise
 * Creates an auditable new revision (e.g. V2, V3).
 */
costingRouter.post('/production-costs/:id/revise', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const costId = Number(req.params.id);

  const original = await queryOne<any>(`SELECT * FROM trx_production_cost WHERE id = ? AND company_id = ?`, [costId, companyId]);
  if (!original) throw NotFound('Costing record not found');

  const newRevision = await transaction(async (tx) => {
    const nextVersion = (original.version || 1) + 1;
    const nextCostNo = `${original.cost_no}-R${nextVersion}`;

    const [insRes] = await tx.execute(`
      INSERT INTO trx_production_cost (
        company_id, cost_no, cost_date, prod_order_id, style_id, buyer_id, unit_id,
        order_qty, planned_qty, produced_qty, costing_period, costing_type, version,
        material_cost, labour_cost, machine_cost, jobwork_cost, process_cost,
        overhead_cost, packing_cost, total_cost, cost_per_piece, estimated_cost,
        variance, variance_pct, status, remarks, data_json, created_by
      ) VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, 'RE_COSTING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)
    `, [
      companyId, nextCostNo, original.prod_order_id, original.style_id, original.buyer_id, original.unit_id,
      original.order_qty, original.planned_qty, original.produced_qty, original.costing_period, nextVersion,
      original.material_cost, original.labour_cost, original.machine_cost, original.jobwork_cost, original.process_cost,
      original.overhead_cost, original.packing_cost, original.total_cost, original.cost_per_piece, original.estimated_cost,
      original.variance, original.variance_pct, `Revision ${nextVersion} created from ${original.cost_no}`,
      original.data_json, userId,
    ]);

    const newId = (insRes as any).insertId;
    // Copy child lines
    const oldLines = await txQuery<any>(tx, `SELECT * FROM trx_production_cost_line WHERE cost_id = ?`, [costId]);
    for (const l of oldLines) {
      await tx.execute(`
        INSERT INTO trx_production_cost_line (
          cost_id, cost_head, cost_category, stage_name, item_description,
          ref_type, ref_id, ref_doc_no, quantity, uom_id, rate, amount, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        newId, l.cost_head, l.cost_category, l.stage_name, l.item_description,
        l.ref_type, l.ref_id, l.ref_doc_no, l.quantity, l.uom_id, l.rate, l.amount, l.remarks,
      ]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_production_cost WHERE id = ?`, [newId]);
  });

  res.json({ data: newRevision, message: `Created Revision V${(newRevision as any).version}` });
}));

/* ==============================================================================
   PART B: MERCHANDISER PRE-COSTING (V2 ENGINE) ENDPOINTS
   ============================================================================== */

/**
 * 5. GET /api/pre-costings/style-data/:styleId
 * Auto-loads Style BOM / Consumption lines and latest approved supplier quotation rates.
 */
costingRouter.get('/pre-costings/style-data/:styleId', requirePermission('COSTING.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const styleId = Number(req.params.styleId);

  // A. Load Style Details
  const style = await queryOne<any>(`
    SELECT st.*, b.id AS buyer_id, b.party_name AS buyer_name,
           p.product_name, fb.id AS fabric_id, fb.fabric_name, fb.fabric_code
      FROM mst_style st
      LEFT JOIN mst_party b ON b.id = st.buyer_id
      LEFT JOIN mst_product p ON p.id = st.product_id
      LEFT JOIN mst_fabric fb ON fb.id = st.fabric_id
     WHERE st.id = ? AND st.company_id = ?
  `, [styleId, companyId]);

  if (!style) throw NotFound('Style not found');

  // B. Load Active Style BOM and lines
  const bomLines = await query<any>(`
    SELECT l.*,
           y.yarn_name, y.yarn_code, y.std_rate AS yarn_std_rate,
           fb.fabric_name, fb.fabric_code, fb.std_rate AS fabric_std_rate,
           tr.trim_name, tr.trim_code, tr.std_rate AS trim_std_rate,
           c.color_name, sz.size_code, u.code AS uom_code
      FROM trx_bom b
      JOIN trx_bom_line l ON l.bom_id = b.id
      LEFT JOIN mst_yarn y ON y.id = l.yarn_id
      LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
      LEFT JOIN mst_trim tr ON tr.id = l.trim_id
      LEFT JOIN mst_color c ON c.id = l.color_id
      LEFT JOIN mst_size sz ON sz.id = l.size_id
      LEFT JOIN cfg_uom u ON u.id = l.uom_id
     WHERE b.style_id = ? AND b.company_id = ? AND b.is_active = 1
     ORDER BY b.version DESC, l.material_type, l.id
  `, [styleId, companyId]);

  // C. Map rates into BOM lines with fallback to standard master rates
  const enrichedLines = bomLines.map((l: any) => {
    let stdRate = 0;
    // Master standard rate only — a material without one shows 0 and rate_missing for the merchandiser to fill.
    if (l.material_type === 'FABRIC') stdRate = Number(l.fabric_std_rate) || 0;
    else if (l.material_type === 'YARN') stdRate = Number(l.yarn_std_rate) || 0;
    else if (l.material_type === 'TRIM') stdRate = Number(l.trim_std_rate) || 0;

    return {
      ...l,
      applied_rate: stdRate,
      rate_missing: stdRate === 0,
      std_rate: stdRate,
      rate_source: 'Standard Rate Master',
    };
  });

  res.json({
    data: {
      style,
      bomLines: enrichedLines,
    },
  });
}));

/**
 * 6. POST /api/pre-costings/calculate
 * Pre-costing roll-up without saving — the same computePreCosting() the costings
 * resource runs on create / update. Body: the sheet's data_json shape
 * (fabrics, yarns, trims, embellishments, processes, cuttingOps, sewingOps,
 * finishingItems, otherDirect, overhead, …) plus margin_pct, smv_rate_per_min,
 * order_qty. `sewing_operations` / `other_charges` are accepted as aliases.
 */
costingRouter.post('/pre-costings/calculate', requirePermission('COSTING.VIEW'), (req, res) => {
  const b = { ...(req.body ?? {}) };
  if (b.sewingOps == null && Array.isArray(b.sewing_operations)) b.sewingOps = b.sewing_operations;
  if (b.otherCharges == null && Array.isArray(b.other_charges)) b.otherCharges = b.other_charges;
  const fallback: Record<string, unknown> = { smv: b.smv };
  for (const h of PRE_COST_HEADS) fallback[h] = b[h];
  const r = computePreCosting(b, { margin_pct: b.margin_pct, smv_rate_per_min: b.smv_rate_per_min, fallback });
  if (r.error) throw BadRequest(r.error);
  const orderQty = Number(b.order_qty) || 0;
  res.json({
    data: {
      ...r.heads,
      ...r,
      total_smv: r.smv,
      direct_cost_per_pc: r.direct_cost,
      total_cost_per_pc: r.total_cost,
      profit_amount_per_pc: r.profit_per_pc,
      fob_price_per_pc: r.fob_price,
      total_order_cost: r.total_cost * orderQty,
      total_order_fob: r.fob_price * orderQty,
      total_order_profit: r.profit_per_pc * orderQty,
    },
  });
});
