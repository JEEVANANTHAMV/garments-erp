import { Router } from 'express';
import { settingFlag, useGateEntry } from '../../core/inwardControls.js';
import { z } from 'zod';
import { closePoLinesShort } from '../../core/poReceipt.js';
import { calcRollFor, fabricSpec, rollTolerances, ROLL_CALC_COLS, rollCalcVals } from '../../core/fabricRollCalc.js';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { computeInvoice, chargesFromRow, invoiceSummaryColumns } from '../../core/invoiceCalc.js';
import { assertPoExcessById } from '../../core/purchaseExcess.js';

export const fabricYarnProcurementRouter = Router();

/* ==============================================================================
   SHARED: JOB (IO) LIST + QUOTATION → PO HELPERS
   (the helpers are also used by POST /trim-pos/convert-from-quotation)
   ============================================================================== */

/**
 * GET /api/procurement/jobs?q=
 * Jobs (sales orders) for the "IO No" selector on Fabric / Yarn / Trims POs and purchase
 * quotations: id, so_no, io_no, buyer, the job's styles (from trx_sales_order_line) and
 * plan-cut qty. Cancelled / rejected orders are left out.
 */
fabricYarnProcurementRouter.get('/procurement/jobs',
  requireAny('PURCHASE.VIEW', 'PROCUREMENT.VIEW', 'QUOTATION.VIEW', 'BOM.VIEW', 'PRODUCTION.VIEW', 'FABRIC_PROCESS.VIEW', 'YARN_PROCESS.VIEW',
    'INVENTORY.VIEW', 'PACKING.VIEW', 'DISPATCH.VIEW', 'EXPORT.VIEW', 'QC.VIEW', 'GATE_INWARD.VIEW', 'COSTING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    q: z.string().trim().max(60).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }).parse(req.query);

  const where = ['so.company_id = ?', 'so.is_deleted = 0', "COALESCE(so.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'REJECTED')"];
  const params: unknown[] = [cid];
  if (q.q) {
    where.push(`(so.io_no LIKE ? OR so.so_no LIKE ? OR so.buyer_po_no LIKE ? OR b.party_name LIKE ?
                 OR EXISTS (SELECT 1 FROM trx_sales_order_line x JOIN mst_style xs ON xs.id = x.style_id
                             WHERE x.so_id = so.id AND xs.style_code LIKE ?))`);
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const jobs = await query<any>(
    `SELECT so.id, so.so_no, so.io_no, so.buyer_po_no, so.so_date, so.ship_date, so.buyer_id,
            b.party_name AS buyer_name
       FROM trx_sales_order so
       LEFT JOIN mst_party b ON b.id = so.buyer_id
      WHERE ${where.join(' AND ')}
      ORDER BY so.so_date DESC, so.id DESC
      LIMIT ${q.limit}`, params);

  const styleRows = jobs.length ? await query<any>(
    `SELECT sol.so_id, sol.style_id, st.style_code, st.style_name,
            SUM(COALESCE(sol.plan_cut_qty, 0)) AS plan_cut_qty, SUM(COALESCE(sol.order_qty, 0)) AS order_qty
       FROM trx_sales_order_line sol
       JOIN mst_style st ON st.id = sol.style_id
      WHERE sol.so_id IN (?)
      GROUP BY sol.so_id, sol.style_id, st.style_code, st.style_name
      ORDER BY st.style_code`, [jobs.map((j) => j.id)]) : [];

  const data = jobs.map((j) => {
    const styles = styleRows.filter((r) => Number(r.so_id) === Number(j.id)).map((r) => ({
      style_id: Number(r.style_id), style_code: r.style_code, style_name: r.style_name,
      plan_cut_qty: Number(r.plan_cut_qty) || 0, order_qty: Number(r.order_qty) || 0,
    }));
    const planCut = styles.reduce((t, s) => t + s.plan_cut_qty, 0);
    const ordered = styles.reduce((t, s) => t + s.order_qty, 0);
    const jobNo = j.io_no || j.so_no;
    return {
      ...j,
      job_no: jobNo,
      styles,
      style_ids: styles.map((s) => s.style_id),
      style_codes: styles.map((s) => s.style_code).join(', '),
      plan_cut_qty: planCut > 0 ? planCut : ordered,
      order_qty: ordered,
      label: [jobNo, j.buyer_name, styles.map((s) => s.style_code).join(', ')].filter(Boolean).join(' — '),
    };
  });
  res.json({ data });
}));

export type QuotationPoKind = 'FABRIC' | 'YARN' | 'TRIMS';

export interface QuotationForPo {
  quote: any;
  /** Quotation lines of this material; `material_id`, `so_id`, `rate` resolved. */
  lines: any[];
  /** Job the PO is for (all lines on one job), else null. */
  soId: number | null;
  /** IO no for the PO header: the job's io_no (else so_no), else the quotation's job no. */
  ioNo: string | null;
  /** Lines whose material master could not be resolved. */
  unresolved: number;
  /** One style for all lines, else null. */
  styleId: number | null;
  isInterstate: boolean;
}

const QUOTE_MATERIAL: Record<QuotationPoKind, { idCol: string; table: string; nameCol: string; codeCol: string; label: string; types: string[] }> = {
  FABRIC: { idCol: 'fabric_id', table: 'mst_fabric', nameCol: 'fabric_name', codeCol: 'fabric_code', label: 'Fabric', types: ['FABRIC'] },
  YARN:   { idCol: 'yarn_id',   table: 'mst_yarn',   nameCol: 'yarn_name',   codeCol: 'yarn_code',   label: 'Yarn',   types: ['YARN'] },
  TRIMS:  { idCol: 'trim_id',   table: 'mst_trim',   nameCol: 'trim_name',   codeCol: 'trim_code',   label: 'Trims',  types: ['TRIM', 'ACCESSORY', 'PACKING'] },
};

/** Confirm rate wins, then quotation rate, then unit price. */
export const quoteLineRate = (ql: any) =>
  Number(ql.confirm_rate) > 0 ? Number(ql.confirm_rate)
    : Number(ql.quotation_rate) > 0 ? Number(ql.quotation_rate)
      : Number(ql.unit_price) || 0;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Line amount + GST split (IGST when the PO is inter-state, else CGST/SGST halves). */
export function quoteLineTax(ql: any, isInterstate: boolean) {
  const qty = Number(ql.qty) || 0;
  const rate = quoteLineRate(ql);
  const amount = round2(qty * rate);
  const gstRate = isInterstate ? (Number(ql.igst_rate) || Number(ql.gst_rate) || 0) : (Number(ql.gst_rate) || Number(ql.igst_rate) || 0);
  const igst = isInterstate ? round2(amount * gstRate / 100) : 0;
  const cgst = isInterstate ? 0 : round2(amount * gstRate / 200);
  const sgst = cgst;
  const tax = round2(igst + cgst + sgst);
  return {
    qty, rate, amount, gstRate, tax,
    igstRate: isInterstate ? gstRate : 0, igst,
    cgstRate: isInterstate ? 0 : gstRate / 2, cgst,
    sgstRate: isInterstate ? 0 : gstRate / 2, sgst,
    net: round2(amount + tax),
  };
}

/**
 * GET /procurement/quoted-rates?kind=FABRIC|YARN|TRIMS&supplier_id=&so_id=
 * Rates a supplier quoted for this kind of material — used by the Fabric / Yarn / Trims PO
 * pages when lines are filled from the job's BOM or picked by hand, so the PO takes the
 * CONFIRMED rate and the GST % of the quotation (not the BOM standard rate / a default GST).
 * Latest quotation first; lines of the same job win over lines without a job. Cancelled /
 * rejected quotations are ignored.
 */
fabricYarnProcurementRouter.get('/procurement/quoted-rates',
  requireAny('PURCHASE.VIEW', 'PROCUREMENT.VIEW', 'QUOTATION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    kind: z.enum(['FABRIC', 'YARN', 'TRIMS']),
    supplier_id: z.coerce.number().int().positive(),
    so_id: z.coerce.number().int().positive().optional(),
  }).parse(req.query);
  const m = QUOTE_MATERIAL[q.kind];
  const rows = await query<any>(
    `SELECT ql.id, ql.bom_line_id, ql.${m.idCol} AS material_id, ql.color_id, ql.size_id, ql.so_id, ql.job_no,
            ql.quotation_rate, ql.confirm_rate, ql.unit_price, ql.gst_rate, ql.igst_rate,
            qt.id AS quotation_id, qt.quotation_no, qt.quotation_date
       FROM trx_quotation_line ql
       JOIN trx_quotation qt ON qt.id = ql.quotation_id
       LEFT JOIN cfg_status cs ON cs.id = qt.status_id
      WHERE qt.company_id = ? AND qt.is_deleted = 0 AND qt.quotation_type = ? AND qt.supplier_id = ?
        AND COALESCE(cs.code, '') NOT IN ('CANCELLED', 'REJECTED')
        AND ql.${m.idCol} IS NOT NULL
        AND (? IS NULL OR ql.so_id IS NULL OR ql.so_id = ?)
      ORDER BY (ql.so_id <=> ?) DESC, qt.quotation_date DESC, qt.id DESC, ql.id`,
    [cid, q.kind, q.supplier_id, q.so_id ?? null, q.so_id ?? null, q.so_id ?? null]);
  res.json({
    data: rows.map((r) => ({
      quotation_id: Number(r.quotation_id), quotation_no: r.quotation_no, quotation_line_id: Number(r.id),
      bom_line_id: r.bom_line_id ? Number(r.bom_line_id) : null, material_id: Number(r.material_id),
      color_id: r.color_id ? Number(r.color_id) : null, size_id: r.size_id ? Number(r.size_id) : null,
      so_id: r.so_id ? Number(r.so_id) : null,
      rate: quoteLineRate(r), confirm_rate: Number(r.confirm_rate) || 0, quotation_rate: Number(r.quotation_rate) || 0,
      gst_rate: Number(r.gst_rate) || Number(r.igst_rate) || 0,
    })),
  });
}));

/**
 * Loads a purchase quotation for conversion into a Fabric / Yarn / Trims PO and resolves
 * each line's material (explicit fabric_id / yarn_id / trim_id, else an exact master name /
 * code match on the description) and the job (line so_id, else the quotation's job no).
 */
export async function loadQuotationForPo(companyId: number, quotationId: number, kind: QuotationPoKind): Promise<QuotationForPo> {
  const m = QUOTE_MATERIAL[kind];
  const quote = await queryOne<any>(
    'SELECT q.* FROM trx_quotation q WHERE q.id = ? AND q.company_id = ? AND q.is_deleted = 0', [quotationId, companyId]);
  if (!quote) throw NotFound('Quotation not found');
  if (quote.quotation_type !== kind) {
    throw BadRequest(`Quotation ${quote.quotation_no} is a ${quote.quotation_type} quotation — select a ${m.label} quotation`);
  }
  if (quote.quotation_category === 'PROCESS') {
    throw BadRequest(`Quotation ${quote.quotation_no} is a process / job-work quotation and cannot become a material PO`);
  }
  if (!quote.supplier_id) throw BadRequest(`Quotation ${quote.quotation_no} has no supplier — set the supplier on the quotation first`);

  const rows = await query<any>(
    `SELECT ql.*, so.so_no AS line_so_no, so.io_no AS line_io_no,
            c.color_name AS line_color_name, sz.size_code AS line_size_code
       FROM trx_quotation_line ql
       LEFT JOIN trx_sales_order so ON so.id = ql.so_id AND so.company_id = ?
       LEFT JOIN mst_color c ON c.id = ql.color_id
       LEFT JOIN mst_size sz ON sz.id = ql.size_id
      WHERE ql.quotation_id = ?
      ORDER BY ql.sort_order, ql.id`, [companyId, quotationId]);
  // Legacy lines carry no material_type: they belong to the quotation's own type
  const lines = rows.filter((l) => !l.material_type || m.types.includes(String(l.material_type).toUpperCase()));
  if (!lines.length) throw BadRequest(`Quotation ${quote.quotation_no} has no ${m.label.toLowerCase()} lines`);

  let unresolved = 0;
  for (const l of lines) {
    if (!(Number(l.qty) > 0)) throw BadRequest(`Quotation line "${l.description || `#${l.id}`}" has no quantity`);
    if (!(quoteLineRate(l) > 0)) throw BadRequest(`Quotation line "${l.description || `#${l.id}`}" has no rate`);
    let materialId = l[m.idCol] ? Number(l[m.idCol]) : null;
    const desc = String(l.description || '').trim();
    if (!materialId && desc) {
      const hit = await queryOne<{ id: number }>(
        `SELECT id FROM ${m.table}
          WHERE company_id = ? AND is_deleted = 0 AND (${m.nameCol} = ? OR ${m.codeCol} = ?)
          ORDER BY is_active DESC, id LIMIT 1`, [companyId, desc, desc]);
      if (hit) materialId = Number(hit.id);
    }
    l.material_id = materialId;
    if (!materialId) unresolved++;
  }

  // Job: the lines' job; else the quotation's job no matched to a sales order
  const soIds = [...new Set(lines.map((l) => Number(l.so_id)).filter((v) => v > 0))];
  let soId: number | null = soIds.length === 1 ? soIds[0] : null;
  let ioNo: string | null = null;
  if (soId) {
    const l = lines.find((x) => Number(x.so_id) === soId);
    ioNo = l.line_io_no || l.line_so_no || null;
  } else if (soIds.length > 1) {
    ioNo = [...new Set(lines.map((l) => l.line_io_no || l.line_so_no).filter(Boolean))].join(', ').slice(0, 60) || null;
  } else {
    const jobNo = String(quote.job_no || lines.find((l) => l.job_no)?.job_no || '').trim();
    if (jobNo) {
      const so = await queryOne<any>(
        `SELECT id, so_no, io_no FROM trx_sales_order
          WHERE company_id = ? AND is_deleted = 0 AND (io_no = ? OR so_no = ?)
          ORDER BY (io_no = ?) DESC, id DESC LIMIT 1`, [companyId, jobNo, jobNo, jobNo]);
      if (so) { soId = Number(so.id); ioNo = so.io_no || so.so_no; } else ioNo = jobNo;
    }
  }
  for (const l of lines) if (!l.so_id && soId) l.so_id = soId;

  const styleIds = [...new Set(lines.map((l) => Number(l.style_id)).filter((v) => v > 0))];
  // IGST on any line → inter-state supplier (the quotation page keys IGST per line)
  const isInterstate = lines.some((l) => Number(l.igst_rate) > 0);
  return { quote, lines, soId, ioNo, unresolved, styleId: styleIds.length === 1 ? styleIds[0] : null, isInterstate };
}

const convertQuotationSchema = z.object({
  quotation_id: z.coerce.number().int().positive(),
  required_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  remarks: z.string().max(2000).nullish(),
  billing_address: z.string().max(5000).nullish(),
  shipping_address: z.string().max(5000).nullish(),
  shipping_to_party_id: z.coerce.number().int().positive().nullish(),
});

/** Blocks converting the same quotation twice (a cancelled PO frees it again). */
async function assertQuotationNotConverted(companyId: number, quotationId: number) {
  const po = await queryOne<{ po_no: string }>(
    `SELECT po_no FROM trx_purchase_order
      WHERE company_id = ? AND quotation_id = ? AND is_deleted = 0 AND COALESCE(approval_state, 'DRAFT') <> 'CANCELLED'
      LIMIT 1`, [companyId, quotationId]);
  if (po) throw BadRequest(`This quotation is already converted to PO ${po.po_no}`);
}

/**
 * Inserts the trx_purchase_order header of a quotation conversion and returns its id.
 * Totals are summed from the already-computed line taxes.
 */
async function insertPoFromQuotation(tx: Tx, req: any, info: QuotationForPo, poNo: string,
  body: z.infer<typeof convertQuotationSchema>, sums: { amount: number; cgst: number; sgst: number; igst: number }, kindLabel: string) {
  const { quote } = info;
  const tax = round2(sums.cgst + sums.sgst + sums.igst);
  const r = await txExecute(tx, `
    INSERT INTO trx_purchase_order (
      company_id, branch_id, po_no, internal_ir_no, po_date, supplier_id,
      po_type, order_type, quotation_id, so_id, style_id, currency_id,
      exchange_rate, delivery_date, payment_terms, is_interstate,
      total_amount, taxable_amount, tax_amount, cgst_amount, sgst_amount, igst_amount, grand_total,
      approval_state, remarks, billing_address, shipping_address, shipping_to_party_id, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    req.user.companyId, quote.branch_id ?? null, poNo, info.ioNo, new Date().toISOString().slice(0, 10), quote.supplier_id,
    'MATERIAL', 'PRODUCTION', quote.id, info.soId, info.styleId, quote.currency_id,
    Number(quote.exchange_rate) || 1, body.required_date || null, quote.payment_terms ?? null, info.isInterstate ? 1 : 0,
    round2(sums.amount), round2(sums.amount), tax, round2(sums.cgst), round2(sums.sgst), round2(sums.igst), round2(sums.amount + tax),
    // A line without a material master stays DRAFT until someone picks the material on the PO
    info.unresolved ? 'DRAFT' : 'APPROVED',
    body.remarks || `Converted from ${kindLabel} Quotation ${quote.quotation_no}`,
    body.billing_address || null, body.shipping_address || null, body.shipping_to_party_id ?? null, req.user.id,
  ]);
  return r.insertId;
}

/** Notes the PO on the quotation remarks (the quotation keeps its own status). */
export async function markQuotationConverted(tx: Tx, quotationId: number, poNo: string) {
  await txExecute(tx,
    `UPDATE trx_quotation SET remarks = CONCAT(COALESCE(remarks, ''), ' [Converted to PO: ', ?, ']') WHERE id = ?`,
    [poNo, quotationId]);
}

const FABRIC_TYPE_LABEL: Record<string, string> = { KNIT: 'Knitted', WOVEN: 'Woven', NONWOVEN: 'Non-Woven' };
const titleCase = (v: unknown) => {
  const t = String(v ?? '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : null;
};

/* ==============================================================================
   PART A: FABRIC PURCHASE & ROLL-LEVEL GRN
   ============================================================================== */

/**
 * 1. POST /api/fabric-purchase-orders/convert-from-quotation
 * Converts a Fabric quotation into a Fabric PO: supplier, currency, payment terms, job (IO)
 * and every fabric line (fabric master, colour, dia / GSM, qty, confirm rate, GST) are carried
 * over. Specs missing on the quotation line come from the fabric master.
 */
fabricYarnProcurementRouter.post('/fabric-purchase-orders/convert-from-quotation', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const body = convertQuotationSchema.parse(req.body);
  await assertQuotationNotConverted(companyId, body.quotation_id);
  const info = await loadQuotationForPo(companyId, body.quotation_id, 'FABRIC');

  const ids = info.lines.map((l) => l.material_id).filter(Boolean);
  const masters = ids.length ? await query<any>(
    `SELECT fb.id, fb.fabric_name, fb.fabric_type, fb.dia_inch, fb.base_uom, fb.hsn_code,
            g.gsm_value, comp.description AS composition
       FROM mst_fabric fb
       LEFT JOIN mst_gsm g ON g.id = fb.gsm_id
       LEFT JOIN mst_composition comp ON comp.id = fb.composition_id
      WHERE fb.id IN (?)`, [ids]) : [];
  const master = new Map(masters.map((f) => [Number(f.id), f]));

  const prepared = info.lines.map((ql) => {
    const fb = ql.material_id ? master.get(Number(ql.material_id)) : null;
    const uomId = ql.uom_id || fb?.base_uom || null;
    if (!uomId) throw BadRequest(`Quotation line "${ql.description || `#${ql.id}`}" has no UOM`);
    const colorName = ql.line_color_name || null;
    return { ql, fb, uomId, colorName, t: quoteLineTax(ql, info.isInterstate) };
  });
  const sums = prepared.reduce((a, p) => ({
    amount: a.amount + p.t.amount, cgst: a.cgst + p.t.cgst, sgst: a.sgst + p.t.sgst, igst: a.igst + p.t.igst,
  }), { amount: 0, cgst: 0, sgst: 0, igst: 0 });

  let poNo = '';
  const poId = await transaction(async (tx) => {
    poNo = await nextDocNumber(tx, companyId, 'PURCHASE_ORDER');
    const newPoId = await insertPoFromQuotation(tx, req, info, poNo, body, sums, 'Fabric');
    for (const { ql, fb, uomId, colorName, t } of prepared) {
      await txExecute(tx, `
        INSERT INTO trx_purchase_order_line (
          po_id, so_id, style_id, material_type, fabric_id, color_id, color_name, description, hsn_code,
          fabric_type, fabric_category, dia, gsm, composition,
          qty, uom_id, rate, amount, taxable_amount, gst_rate,
          cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, tax_amount, net_amount, received_qty
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, [
        newPoId, ql.so_id ?? null, ql.style_id ?? null, 'FABRIC', ql.material_id ?? null, ql.color_id ?? null, colorName,
        (ql.description || fb?.fabric_name || '').slice(0, 255) || null, fb?.hsn_code ?? null,
        fb ? (FABRIC_TYPE_LABEL[fb.fabric_type] ?? fb.fabric_type) : null,
        colorName ? 'Dyed Fabric' : 'Grey Fabric',
        ql.dia || (fb?.dia_inch ? `${Number(fb.dia_inch)}"` : null),
        ql.gsm || (fb?.gsm_value ? String(fb.gsm_value) : null),
        fb?.composition ?? null,
        t.qty, uomId, t.rate, t.amount, t.amount, t.gstRate,
        t.cgstRate, t.cgst, t.sgstRate, t.sgst, t.igstRate, t.igst, t.tax, t.net,
      ]);
    }
    await markQuotationConverted(tx, info.quote.id, poNo);
    await assertPoExcessById(tx, companyId, Number(newPoId));
    return newPoId;
  });

  await audit(req, 'trx_purchase_order', poId, 'INSERT', null, { po_no: poNo, quotation_id: body.quotation_id });
  res.json({ data: { id: poId, po_no: poNo, unresolved_lines: info.unresolved } });
}));

/**
 * 2. POST /api/fabric-grns
 * Creates a Fabric GRN with roll-level tracking and updates stock ledger
 */
fabricYarnProcurementRouter.post('/fabric-grns', requirePermission('GRN.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  let finalGrnNo = body.grn_no;

  const grnId = await transaction(async (tx) => {
    if (!finalGrnNo) {
      finalGrnNo = await nextDocNumber(tx, companyId, 'GRN');
    }

    // 1. Calculate totals across lines
    const lines = Array.isArray(body.lines) ? body.lines : [];
    // GSM / Dia / meter per roll (server formula, client doc 03-Oct-2026): target GSM from the roll / PO line / fabric,
    // the roll's entered GSM is the actual (QC) GSM, an entered meter is the measured meter. A roll outside the
    // GSM / meter tolerance goes on hold (counted as hold qty). CONDITIONAL from the screen = HOLD on the roll.
    const tol = await rollTolerances(companyId);
    for (const line of lines) {
      const pol = line.po_line_id ? await txQueryOne<any>(tx, 'SELECT gsm, dia FROM trx_purchase_order_line WHERE id = ?', [Number(line.po_line_id)]) : null;
      const spec = await fabricSpec(Number(line.fabric_id) || null, tx);
      const uom = line.uom_id ? await txQueryOne<any>(tx, 'SELECT code FROM cfg_uom WHERE id = ?', [Number(line.uom_id)]) : null;
      const kgLine = ['KG', 'KGS'].includes(String(uom?.code ?? '').toUpperCase());
      for (const r of (Array.isArray(line.rolls) ? line.rolls : [])) {
        if (!(Number(r.weight_kg) > 0)) continue;
        // roll GSM (pre-filled from the PO) = target; actual_gsm = the QC GSM; the roll length = measured meter
        const c = await calcRollFor(companyId, {
          fabric_id: Number(line.fabric_id) || null, weight_kg: Number(r.weight_kg), on: body.grn_date || null,
          target_gsm: Number(r.target_gsm) || Number(r.gsm) || Number.parseFloat(String(pol?.gsm ?? '')) || null,
          actual_gsm: Number(r.actual_gsm) || null, dia: r.dia || pol?.dia || null, fabric_form: r.fabric_form ?? null,
          actual_meters: Number(r.actual_meters ?? r.meters) || null,
        }, tx, { tol, spec });
        r._calc = c;
        // hold only on a real measurement: a QC GSM, or a measured meter on a KG line (a metre line's length is its order qty split)
        const measured = Number(r.actual_gsm) > 0 || (kgLine && Number(r.actual_meters ?? r.meters) > 0);
        if (c.out_of_tolerance && measured && (r.qc_status || 'ACCEPTED') === 'ACCEPTED') { r.qc_status = 'CONDITIONAL'; r._hold = c.reasons.join('; '); }
      }
    }
    let totTaxable = 0;
    let totCgst = 0;
    let totSgst = 0;
    let totIgst = 0;
    const isInterstate = Boolean(body.is_interstate);

    // Quantities are in the line's (= PO's) UOM: a KG line is received / billed by roll WEIGHT,
    // a metre line by roll METRES. With rolls entered, the server derives the quantities from
    // them and always prices taxable = accepted qty × rate (the client's amount is not trusted).
    const uomIds = [...new Set(lines.map((l: any) => Number(l.uom_id)).filter(Boolean))];
    const uomCodes = new Map<number, string>(uomIds.length
      ? (await txQuery<any>(tx, 'SELECT id, code FROM cfg_uom WHERE id IN (?)', [uomIds])).map((u) => [Number(u.id), String(u.code || '').toUpperCase()])
      : []);
    const calculatedLines = lines.map((line: any) => {
      const isKg = ['KG', 'KGS'].includes(uomCodes.get(Number(line.uom_id)) ?? '');
      const rolls: any[] = Array.isArray(line.rolls) ? line.rolls : [];
      const rq = (r: any) => Number(isKg ? r.weight_kg : r.meters) || 0;
      const sumBy = (st?: string) => rolls.filter((r) => !st || (r.qc_status || 'ACCEPTED') === st).reduce((a, r) => a + rq(r), 0);
      const fromRolls = rolls.length > 0 && rolls.some((r) => rq(r) > 0);
      const recQty = fromRolls ? sumBy() : Number(line.received_qty) || 0;
      const accQty = fromRolls ? sumBy('ACCEPTED') : Number(line.accepted_qty !== undefined ? line.accepted_qty : recQty);
      const rejQty = fromRolls ? sumBy('REJECTED') : Number(line.rejected_qty) || 0;
      const holdQty = fromRolls ? sumBy('CONDITIONAL') + sumBy('HOLD') : Number(line.hold_qty) || 0;
      const rollWeight = rolls.reduce((a, r) => a + (Number(r.weight_kg) || 0), 0);
      line.received_weight = Number(line.received_weight) || rollWeight || (isKg ? recQty : 0);
      const poQty = Number(line.po_qty) || recQty;
      const balanceQty = Math.max(0, poQty - accQty);
      const rate = Number(line.rate) || 0;
      const taxable = Math.round(accQty * rate * 100) / 100;
      const gstRate = Number(line.gst_rate !== undefined ? line.gst_rate : 5);

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      if (isInterstate) {
        igst = Number(((taxable * gstRate) / 100).toFixed(4));
      } else {
        cgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
        sgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
      }
      const taxAmt = cgst + sgst + igst;
      const lineTotal = taxable + taxAmt;

      totTaxable += taxable;
      totCgst += cgst;
      totSgst += sgst;
      totIgst += igst;

      return {
        ...line,
        recQty,
        accQty,
        rejQty,
        holdQty,
        balanceQty,
        rate,
        taxable,
        gstRate,
        cgst,
        sgst,
        igst,
        taxAmt,
        lineTotal,
      };
    });

    const totTax = totCgst + totSgst + totIgst;
    const netAmount = totTaxable + totTax;

    // Common invoice summary: landed heads, ± other charges, TCS (+), TDS (−), round off.
    const summary = computeInvoice(
      calculatedLines.map((l: any) => ({ taxable: l.taxable, tax: l.taxAmt })),
      isInterstate ? 'INTER_STATE' : 'INTRA_STATE',
      chargesFromRow(body, 'tcs_rate'),
    );
    const summaryCols = invoiceSummaryColumns(body, summary, 'tcs_rate');
    const freightCharges = summaryCols.freight_charges;
    const otherCharges = summaryCols.other_charges;
    const roundOff = summary.roundOff;
    const tcsRate = Number(summaryCols.tcs_rate) || 0;
    const tcsApplicable = tcsRate > 0;
    const tcsSection = tcsApplicable ? (body.tcs_section || '206C(1H)') : null;
    const tcsAmount = summary.tcs;
    const grandTotal = summary.net;

    // every inward is mapped to its security gate entry (client voice note 02-Oct-2026)
    if (!body.gate_inward_id && await settingFlag(companyId, 'GATE_ENTRY_REQUIRED_FOR_INWARD', false)) throw BadRequest('Map the gate entry of this GRN (security gate entry is required for every inward)');
    const poIds = Array.isArray(body.po_ids)
      ? body.po_ids.map(Number).filter((n: number) => n > 0)
      : (body.po_id ? [Number(body.po_id)] : []);
    const primaryPoId = poIds[0] || (body.po_id ? Number(body.po_id) : null);
    const poIdsJson = poIds.length > 0 ? JSON.stringify(poIds) : null;

    // 2. Create GRN Header
    const grnRes = await txExecute(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, po_ids, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, is_interstate,
        taxable_amount, tax_amount, cgst_amount, sgst_amount, igst_amount, net_amount,
        freight_charges, other_charges, round_off,
        tcs_applicable, tcs_section, tcs_rate, tcs_amount, grand_total,
        remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || null,   // no fake IO — the job comes from the PO / GRN line
      body.grn_date || new Date().toISOString().slice(0, 10),
      primaryPoId,
      poIdsJson,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      isInterstate ? 1 : 0,
      totTaxable,
      totTax,
      totCgst,
      totSgst,
      totIgst,
      netAmount,
      freightCharges,
      otherCharges,
      roundOff,
      tcsApplicable ? 1 : 0,
      tcsSection,
      tcsRate,
      tcsAmount,
      grandTotal,
      body.remarks || null,
      userId,
    ]);

    const newGrnId = grnRes!.insertId;
    await txExecute(tx, 'UPDATE trx_grn SET receipt_type = ? WHERE id = ?', [body.receipt_type === 'FINAL' ? 'FINAL' : (primaryPoId ? 'PARTIAL' : null), newGrnId]);
    await txExecute(tx, `
      UPDATE trx_grn SET insurance = ?, customs_duty = ?, clearing_charges = ?,
             other_charges_sign = ?, other_charges_label = ?,
             tds_section = ?, tds_pct = ?, tds_amount = ?
       WHERE id = ?
    `, [summaryCols.insurance, summaryCols.customs_duty, summaryCols.clearing_charges,
        summaryCols.other_charges_sign, summaryCols.other_charges_label,
        summaryCols.tds_section, summaryCols.tds_pct, summaryCols.tds_amount, newGrnId]);

    // the gate entry must be this supplier's (and not cancelled); it is marked GRN completed
    if (body.gate_inward_id) await useGateEntry(tx, companyId, { gate_inward_id: Number(body.gate_inward_id), party_id: Number(body.supplier_id) || null, label: 'Fabric GRN' });

    // 3. Insert GRN Lines
    for (const line of calculatedLines) {
      const linePoId = line.po_id ? Number(line.po_id) : primaryPoId;
      const lineRes = await txExecute(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_id, po_line_id, so_id, style_id, material_type, fabric_id,
          fabric_category, pantone_spec, color_name, shade_code,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          rate, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, total_amount,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        linePoId,
        line.po_line_id ? Number(line.po_line_id) : null,
        line.so_id ? Number(line.so_id) : (body.so_id ? Number(body.so_id) : null),
        line.style_id ? Number(line.style_id) : (body.style_id ? Number(body.style_id) : null),
        'FABRIC',
        Number(line.fabric_id),
        line.fabric_category || 'Grey Fabric',
        line.pantone_spec || null,
        line.color_name || null,
        line.shade_code || null,
        line.recQty,
        Number(line.received_weight) || 0,
        Number(line.no_of_rolls || 1),
        line.accQty,
        line.rejQty,
        line.holdQty,
        line.balanceQty,
        line.rate,
        line.taxable,
        line.gstRate,
        line.cgst,
        line.sgst,
        line.igst,
        line.lineTotal,
        line.lot_no || 'LOT-DEFAULT',
        line.qc_status || body.qc_status || 'ACCEPTED',
        line.uom_id || 9,
      ]);

      const grnLineId = lineRes!.insertId;

      // 3. Insert Roll-Level Details
      const rolls = Array.isArray(line.rolls) ? line.rolls : [];
      for (let i = 0; i < rolls.length; i++) {
        const r = rolls[i];
        const rNo = r.roll_no || `R-${finalGrnNo}-${i + 1}`;
        await txExecute(tx, `
          INSERT INTO trx_fabric_roll (
            company_id, grn_id, grn_line_id, fabric_id,
            roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
            warehouse_id, location_bin, qc_status, stock_status, remarks, so_id, ${ROLL_CALC_COLS}
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          newGrnId,
          grnLineId,
          Number(line.fabric_id),
          rNo,
          r.lot_no || line.lot_no || null,
          Number(r.meters || r.qty) || r._calc?.meters || 0,
          Number(r.weight_kg) || 0,
          r._calc?.actual_gsm ? Math.round(r._calc.actual_gsm) : (Number(r.gsm) || (r._calc?.target_gsm ? Math.round(r._calc.target_gsm) : null)),
          r.dia || null,
          r.shade || line.shade_code || null,
          Number(body.warehouse_id),
          r.location_bin || null,
          // the roll table knows PENDING / ACCEPTED / HOLD / REJECTED — the screen's CONDITIONAL is a hold
          r.qc_status === 'CONDITIONAL' ? 'HOLD' : (r.qc_status || 'ACCEPTED'),
          (r.qc_status || 'ACCEPTED') === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED',
          [r.remarks, r._hold ? `QC hold: ${r._hold}` : null].filter(Boolean).join(' — ') || null,
          // the roll belongs to the job it was bought for (job-wise stock / transfers)
          line.so_id ? Number(line.so_id) : (body.so_id ? Number(body.so_id) : null),
          ...(r._calc ? rollCalcVals(r._calc) : [null, null, null, null, null, null, null, null, null, null, null]),
        ]);
      }

      // 4. Update PO Line Received Qty
      if (line.po_line_id) {
        await txExecute(tx, `
          UPDATE trx_purchase_order_line
             SET received_qty = COALESCE(received_qty, 0) + ?
           WHERE id = ?
        `, [line.accQty, line.po_line_id]);
        // FINAL receipt: the PO line is closed (short if less than ordered came)
        if (body.receipt_type === 'FINAL') await closePoLinesShort(tx, 'PO', [Number(line.po_line_id)], newGrnId);
      }

      // 5. Post to Stock Ledger if Accepted
      if (line.accQty > 0 && body.qc_status !== 'REJECTED') {
        await txExecute(tx, `
          INSERT INTO trx_stock_ledger (
            company_id, warehouse_id, material_type, fabric_id,
            txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          Number(body.warehouse_id),
          'FABRIC',
          Number(line.fabric_id),
          'GRN',
          'GRN',
          newGrnId,
          line.accQty,
          0,
          line.uom_id || 9,
          Number(line.rate || 0),
        ]);
      }
    }

    return newGrnId;
  });

  await audit(req, 'trx_grn', grnId, 'INSERT', null, { grn_no: finalGrnNo, po_id: body.po_id });

  res.json({ data: { id: grnId, grn_no: finalGrnNo } });
}));

/**
 * GET /api/fabric-grns
 */
fabricYarnProcurementRouter.get('/fabric-grns', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const rows = await query<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no,
           COALESCE((SELECT SUM(gl.received_qty) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC'), 0) AS total_meters,
           COALESCE((SELECT SUM(gl.received_weight) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC'), 0) AS total_weight_kg,
           COALESCE((SELECT COUNT(*) FROM trx_fabric_roll fr WHERE fr.grn_id = g.id), (SELECT SUM(gl.no_of_rolls) FROM trx_grn_line gl WHERE gl.grn_id = g.id)) AS roll_count
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.company_id = ?
       AND (EXISTS (SELECT 1 FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC')
            OR po.po_no LIKE 'FPO%' OR g.grn_no LIKE 'FGRN%')
     ORDER BY g.id DESC
  `, [companyId]);
  res.json({ data: rows });
}));

/**
 * GET /api/fabric-grns/:id
 */
fabricYarnProcurementRouter.get('/fabric-grns/:id', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const grn = await queryOne<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.id = ? AND g.company_id = ?
  `, [id, companyId]);

  if (!grn) throw NotFound('Fabric GRN not found');

  const lines = await query<any>(`
    SELECT gl.*, po.po_no, fb.fabric_name, fb.fabric_code, comp.description AS construction, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN trx_purchase_order po ON po.id = gl.po_id
      LEFT JOIN mst_fabric fb ON fb.id = gl.fabric_id
      LEFT JOIN mst_composition comp ON comp.id = fb.composition_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [id]);

  const rolls = await query<any>(`
    SELECT fr.*, fb.fabric_name, fb.fabric_code
      FROM trx_fabric_roll fr
      LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
     WHERE fr.grn_id = ?
     ORDER BY fr.id ASC
  `, [id]);

  res.json({ data: { ...grn, lines, rolls } });
}));

/* ------------------------------------------------------------------------------
   Shared helpers for the roll / yarn stock lists
   ------------------------------------------------------------------------------ */

/**
 * Tables that only exist once later migrations ran. Production schemas can lag
 * behind local, so optional sources are probed once per process instead of
 * letting a missing table 500 the whole stock list.
 */
const tableExistsCache = new Map<string, boolean>();
async function tableExists(name: string): Promise<boolean> {
  const hit = tableExistsCache.get(name);
  if (hit !== undefined) return hit;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name]);
  const ok = Number(row?.n ?? 0) > 0;
  tableExistsCache.set(name, ok);
  return ok;
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const hit = tableExistsCache.get(key);
  if (hit !== undefined) return hit;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  const ok = Number(row?.n ?? 0) > 0;
  tableExistsCache.set(key, ok);
  return ok;
}

/**
 * Job (IO) + style traceability joins for anything hanging off a GRN line.
 * Expects aliases `gl` (trx_grn_line) and `grn` (trx_grn). Resolution order is
 * most-specific first: GRN line → PO line → line sales order → PO header →
 * GRN header → PO's sales order → the IO's CAD requirement. A sales order only contributes a style when
 * it carries exactly one style (otherwise it would be a guess).
 */
const TRACE_JOINS = `
      LEFT JOIN trx_purchase_order_line pol ON pol.id = gl.po_line_id
      LEFT JOIN trx_purchase_order po
             ON po.id = COALESCE(gl.po_id, pol.po_id, grn.po_id) AND po.company_id = grn.company_id
      LEFT JOIN trx_sales_order so_l
             ON so_l.id = COALESCE(gl.so_id, pol.so_id) AND so_l.company_id = grn.company_id
      LEFT JOIN trx_sales_order so_h
             ON so_h.id = po.so_id AND so_h.company_id = grn.company_id
      LEFT JOIN (SELECT so_id, MIN(style_id) AS style_id
                   FROM trx_sales_order_line
                  GROUP BY so_id
                 HAVING COUNT(DISTINCT style_id) = 1) sol_l ON sol_l.so_id = so_l.id
      LEFT JOIN (SELECT so_id, MIN(style_id) AS style_id
                   FROM trx_sales_order_line
                  GROUP BY so_id
                 HAVING COUNT(DISTINCT style_id) = 1) sol_h ON sol_h.so_id = so_h.id
      LEFT JOIN (SELECT company_id, internal_ir_no, MIN(style_id) AS style_id
                   FROM trx_cad_requirement
                  WHERE internal_ir_no IS NOT NULL AND internal_ir_no <> '' AND style_id IS NOT NULL
                  GROUP BY company_id, internal_ir_no
                 HAVING COUNT(DISTINCT style_id) = 1) cad_io
             ON cad_io.company_id = grn.company_id
            AND cad_io.internal_ir_no = COALESCE(NULLIF(grn.internal_ir_no,''), NULLIF(po.internal_ir_no,''))`;

// Last resort: the internal order's CAD requirement, which is where job-wise
// fabric/yarn buying usually starts (the GRN often carries only the IO no).
const TRACE_STYLE_ID = `COALESCE(gl.style_id, pol.style_id, sol_l.style_id, po.style_id, grn.style_id, sol_h.style_id, cad_io.style_id)`;
const TRACE_IO_NO = `COALESCE(NULLIF(so_l.io_no,''), NULLIF(grn.internal_ir_no,''), NULLIF(po.internal_ir_no,''), NULLIF(so_h.io_no,''))`;
const TRACE_SO_NO = `COALESCE(so_l.so_no, so_h.so_no)`;

const rollListQuery = z.object({
  fabric_id: z.coerce.number().int().positive().optional(),
  grn_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  lot_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  shade: z.string().trim().max(80).optional().transform((v) => v || undefined),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  stock_status: z.enum(['AVAILABLE', 'RESERVED', 'ISSUED', 'PARTIAL', 'CLOSED']).optional(),
  search: z.string().trim().max(100).optional().transform((v) => v || undefined),
});

/**
 * 3. GET /api/fabric-rolls
 * Search and list physical fabric roll stock, with the job (IO) and style the
 * roll was bought for resolved from the roll's own GRN line.
 */
fabricYarnProcurementRouter.get('/fabric-rolls', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const q = rollListQuery.parse(req.query);

  const where: string[] = [];
  const params: any[] = [companyId];

  if (q.fabric_id) { where.push(`t.fabric_id = ?`); params.push(q.fabric_id); }
  if (q.grn_id) { where.push(`t.grn_id = ?`); params.push(q.grn_id); }
  if (q.lot_no) { where.push(`t.lot_no LIKE ?`); params.push(`%${q.lot_no}%`); }
  if (q.shade) { where.push(`t.shade LIKE ?`); params.push(`%${q.shade}%`); }
  if (q.qc_status) { where.push(`t.qc_status = ?`); params.push(q.qc_status); }
  if (q.stock_status) { where.push(`t.stock_status = ?`); params.push(q.stock_status); }
  if (q.warehouse_id) { where.push(`t.warehouse_id = ?`); params.push(q.warehouse_id); }
  if (q.io_no) { where.push(`t.internal_ir_no = ?`); params.push(q.io_no); }
  if (q.style_id) { where.push(`t.style_id = ?`); params.push(q.style_id); }
  if (q.search) {
    where.push(`(t.roll_no LIKE ? OR t.lot_no LIKE ? OR t.fabric_name LIKE ? OR t.fabric_code LIKE ?
             OR t.shade LIKE ? OR t.grn_no LIKE ? OR t.po_no LIKE ? OR t.internal_ir_no LIKE ?
             OR t.style_code LIKE ? OR t.style_name LIKE ? OR t.location_bin LIKE ?)`);
    const term = `%${q.search}%`;
    params.push(term, term, term, term, term, term, term, term, term, term, term);
  }

  const rows = await query<any>(`
    SELECT t.* FROM (
      SELECT fr.*,
             (COALESCE(fr.weight_kg,0) - COALESCE(fr.issued_kg,0)) AS balance_kg,
             fb.fabric_name, fb.fabric_code,
             wh.warehouse_name,
             grn.grn_no, grn.grn_date,
             po.po_no,
             ${TRACE_SO_NO}   AS so_no,
             ${TRACE_IO_NO}   AS internal_ir_no,
             ${TRACE_STYLE_ID} AS style_id,
             st.style_code, st.style_name,
             sup.party_name AS supplier_name
        FROM trx_fabric_roll fr
        JOIN trx_grn grn ON grn.id = fr.grn_id AND grn.company_id = fr.company_id
        LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id AND gl.grn_id = grn.id
        ${TRACE_JOINS}
        LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
        LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
        LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id
        LEFT JOIN mst_party sup ON sup.id = grn.supplier_id
       WHERE fr.company_id = ?
    ) t
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.id DESC
  `, params);

  const facets = await query<any>(`
    SELECT DISTINCT ${TRACE_IO_NO} AS io_no, ${TRACE_STYLE_ID} AS style_id, st.style_code, st.style_name
      FROM trx_fabric_roll fr
      JOIN trx_grn grn ON grn.id = fr.grn_id AND grn.company_id = fr.company_id
      LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id AND gl.grn_id = grn.id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
     WHERE fr.company_id = ?
  `, [companyId]);

  res.json({ data: rows, facets: buildTraceFacets(facets) });
}));

/** Distinct IO numbers + styles for the stock list filter dropdowns. */
function buildTraceFacets(facets: any[]) {
  const ioNos = [...new Set(facets.map((f) => f.io_no).filter(Boolean))].sort();
  const styleMap = new Map<number, { id: number; style_code: string; style_name: string }>();
  for (const f of facets) {
    if (f.style_id && !styleMap.has(Number(f.style_id))) {
      styleMap.set(Number(f.style_id), { id: Number(f.style_id), style_code: f.style_code, style_name: f.style_name });
    }
  }
  return {
    io_nos: ioNos,
    styles: [...styleMap.values()].sort((a, b) => String(a.style_code).localeCompare(String(b.style_code))),
  };
}


/**
 * 4. POST /api/fabric-rolls/:id/status
 * Update roll stock status (e.g. AVAILABLE, RESERVED, ISSUED, CLOSED)
 */
const rollStatusSchema = z.object({
  stock_status: z.enum(['AVAILABLE', 'RESERVED', 'ISSUED', 'PARTIAL', 'CLOSED']).optional(),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  location_bin: z.string().trim().max(50).optional(),
});

fabricYarnProcurementRouter.post('/fabric-rolls/:id/status', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid roll id');
  const body = rollStatusSchema.parse(req.body ?? {});

  const roll = await queryOne<any>(`
    SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!roll) throw NotFound('Roll not found');

  await query(`
    UPDATE trx_fabric_roll
       SET stock_status = COALESCE(?, stock_status),
           qc_status = COALESCE(?, qc_status),
           location_bin = COALESCE(?, location_bin)
     WHERE id = ? AND company_id = ?
  `, [body.stock_status ?? null, body.qc_status ?? null, body.location_bin || null, id, companyId]);

  await audit(req, 'trx_fabric_roll', id, 'UPDATE',
    { stock_status: roll.stock_status, qc_status: roll.qc_status, location_bin: roll.location_bin },
    body);

  res.json({ data: { success: true, id } });
}));

/* ==============================================================================
   PART A-5: YARN STOCK LIST (batch/lot level)
   ============================================================================== */

export const yarnStockQuery = z.object({
  yarn_id: z.coerce.number().int().positive().optional(),
  grn_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  lot_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  shade: z.string().trim().max(80).optional().transform((v) => v || undefined),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'PARTIAL_ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  stock_status: z.enum(['AVAILABLE', 'PARTIAL', 'CLOSED', 'PENDING', 'HOLD', 'REJECTED']).optional(),
  search: z.string().trim().max(100).optional().transform((v) => v || undefined),
});

/**
 * Yarn issued out of stock, keyed by yarn + lot. Every issue screen in the
 * system (knitting work order, knitting program, yarn process) records the lot
 * it drew from rather than the GRN line, so issues are summed per yarn/lot and
 * then spread FIFO over that lot's GRN lines in the main query.
 */
async function yarnLotIssueSql(companyId: number): Promise<{ sql: string; params: any[] }> {
  const parts: string[] = [];
  const params: any[] = [];
  if (await tableExists('trx_knitting_yarn_issue')) {
    parts.push(`SELECT yarn_id, yarn_lot_no AS lot_no, issued_weight_kg AS qty
                  FROM trx_knitting_yarn_issue WHERE company_id = ?`);
    params.push(companyId);
  }
  if (await tableExists('trx_knitting_program_yarn_issues')) {
    parts.push(`SELECT yarn_id, yarn_lot_no AS lot_no, issued_qty_kg AS qty
                  FROM trx_knitting_program_yarn_issues WHERE company_id = ?`);
    params.push(companyId);
  }
  if (await tableExists('trx_process_issue')) {
    // Issues that name their GRN lot are counted on that lot directly (direct_issued_qty)
    parts.push(`SELECT yarn_id, lot_no, issued_qty_kg AS qty
                  FROM trx_process_issue WHERE company_id = ? AND grn_line_id IS NULL`);
    params.push(companyId);
  }
  if (!parts.length) {
    return { sql: `SELECT NULL AS yarn_id, NULL AS lot_no, 0 AS issued_qty FROM DUAL WHERE 1 = 0`, params };
  }
  return {
    sql: `SELECT x.yarn_id, x.lot_no, SUM(x.qty) AS issued_qty
            FROM (${parts.join(' UNION ALL ')}) x
           WHERE x.yarn_id IS NOT NULL AND x.lot_no IS NOT NULL AND x.lot_no <> ''
           GROUP BY x.yarn_id, x.lot_no`,
    params,
  };
}

/**
 * GET /api/yarn-stock
 * Yarn stock per GRN lot line with Internal Order No & Style traceability.
 * Mirrors /fabric-rolls but for yarn — yarn is tracked at batch/lot level, not
 * individual roll.
 *
 * Balance = accepted − purchase returns − yarn issued from that lot. Note that
 * trx_grn_line.balance_qty is the PO quantity still to be received, NOT stock,
 * so it is exposed as po_pending_qty and never used as the stock balance.
 */
/** Yarn stock per GRN lot line (shared by /yarn-stock, the job-wise lot picker and job transfers). */
export async function yarnStockRows(companyId: number, q: z.infer<typeof yarnStockQuery>) {

  const lotIssue = await yarnLotIssueSql(companyId);
  const hasReturns = await tableExists('trx_purchase_return_line') && await tableExists('trx_purchase_return');
  const hasMatIssue = await tableExists('trx_material_issue_line') && await tableExists('trx_material_issue');

  // A return only takes yarn out of the store once its stock is posted.
  const returnPostedCond = hasReturns && await columnExists('trx_purchase_return', 'stock_posted')
    ? 'AND pr.stock_posted = 1' : '';
  const returnedSql = hasReturns
    ? `COALESCE((SELECT SUM(prl.return_qty)
                   FROM trx_purchase_return_line prl
                   JOIN trx_purchase_return pr ON pr.id = prl.return_id
                  WHERE prl.grn_line_id = gl.id AND pr.company_id = grn.company_id
                    AND pr.status <> 'CANCELLED' ${returnPostedCond}), 0)`
    : '0';
  // General material issues reference the batch, not the lot.
  const matIssueSql = hasMatIssue
    ? `CASE WHEN gl.batch_id IS NULL THEN 0 ELSE COALESCE((
         SELECT SUM(mil.issued_qty)
           FROM trx_material_issue_line mil
           JOIN trx_material_issue mi ON mi.id = mil.issue_id
          WHERE mi.company_id = grn.company_id AND mil.material_type = 'YARN'
            AND mil.yarn_id = gl.yarn_id AND mil.batch_id = gl.batch_id), 0) END`
    : '0';

  const where: string[] = [];
  const filterParams: any[] = [];
  if (q.yarn_id) { where.push(`s.yarn_id = ?`); filterParams.push(q.yarn_id); }
  if (q.grn_id) { where.push(`s.grn_id = ?`); filterParams.push(q.grn_id); }
  if (q.warehouse_id) { where.push(`s.warehouse_id = ?`); filterParams.push(q.warehouse_id); }
  if (q.style_id) { where.push(`s.style_id = ?`); filterParams.push(q.style_id); }
  if (q.io_no) { where.push(`s.internal_ir_no = ?`); filterParams.push(q.io_no); }
  if (q.lot_no) { where.push(`s.lot_no LIKE ?`); filterParams.push(`%${q.lot_no}%`); }
  if (q.shade) { where.push(`(s.shade LIKE ? OR s.color_name LIKE ?)`); filterParams.push(`%${q.shade}%`, `%${q.shade}%`); }
  if (q.qc_status) { where.push(`s.qc_status = ?`); filterParams.push(q.qc_status); }
  if (q.stock_status) { where.push(`s.stock_status = ?`); filterParams.push(q.stock_status); }
  if (q.search) {
    where.push(`(s.lot_no LIKE ? OR s.yarn_name LIKE ? OR s.yarn_code LIKE ? OR s.shade LIKE ?
             OR s.color_name LIKE ? OR s.internal_ir_no LIKE ? OR s.style_code LIKE ? OR s.style_name LIKE ?
             OR s.grn_no LIKE ? OR s.po_no LIKE ? OR s.supplier_name LIKE ? OR s.location_bin LIKE ?)`);
    const term = `%${q.search}%`;
    filterParams.push(term, term, term, term, term, term, term, term, term, term, term, term);
  }

  const rows = await query<any>(`
    WITH base AS (
      SELECT
        gl.id, gl.grn_id, gl.yarn_id, gl.lot_no, gl.batch_id,
        gl.shade_code                        AS shade,
        gl.color_name,
        gl.yarn_type                         AS grn_yarn_type,
        gl.received_qty, gl.accepted_qty, gl.rejected_qty, gl.hold_qty,
        gl.balance_qty                       AS po_pending_qty,
        gl.qc_status,
        gl.received_weight                   AS weight_kg,
        gl.no_of_rolls                       AS packs,
        gl.bin_id, gl.uom_id,
        u.code                               AS uom_code,
        yn.yarn_name, yn.yarn_code,
        yn.yarn_type,
        yn.count_value, yn.count_type, yn.ply,
        CONCAT_WS(' ', CONCAT(yn.count_value, IF(yn.count_type IS NULL, '', CONCAT(' ', yn.count_type))),
                  IF(yn.ply IS NULL OR yn.ply <= 1, NULL, CONCAT(yn.ply, '-ply'))) AS count_str,
        grn.warehouse_id, wh.warehouse_name,
        wb.bin_code                          AS location_bin, wb.rack,
        grn.grn_no, grn.grn_date,
        po.po_no,
        sup.party_name                       AS supplier_name,
        ${TRACE_SO_NO}                       AS so_no,
        ${TRACE_IO_NO}                       AS internal_ir_no,
        ${TRACE_STYLE_ID}                    AS style_id,
        st.style_code, st.style_name,
        COALESCE(so_l.id, so_h.id)           AS owner_so_id,
        COALESCE((SELECT SUM(dpi.issued_qty_kg) FROM trx_process_issue dpi WHERE dpi.grn_line_id = gl.id), 0) AS direct_issued_qty,
        (gl.accepted_qty - ${returnedSql})   AS net_in_qty,
        ${returnedSql}                       AS returned_qty,
        ${matIssueSql}                       AS batch_issued_qty
      FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
      LEFT JOIN mst_yarn yn ON yn.id = gl.yarn_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
      LEFT JOIN mst_warehouse wh ON wh.id = grn.warehouse_id
      LEFT JOIN mst_warehouse_bin wb ON wb.id = gl.bin_id
      LEFT JOIN mst_party sup ON sup.id = grn.supplier_id
      WHERE grn.company_id = ?
        AND gl.material_type = 'YARN'
        AND gl.yarn_id IS NOT NULL
    ),
    lot_issue AS (${lotIssue.sql}),
    fifo AS (
      SELECT b.*,
             COALESCE(li.issued_qty, 0) AS lot_issued_qty,
             COALESCE(SUM(GREATEST(b.net_in_qty, 0)) OVER (
               PARTITION BY b.yarn_id, b.lot_no ORDER BY b.grn_date, b.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS lot_in_before
        FROM base b
        LEFT JOIN lot_issue li ON li.yarn_id = b.yarn_id AND li.lot_no = b.lot_no
    ),
    calc AS (
      SELECT f.*,
             (LEAST(GREATEST(f.net_in_qty, 0), GREATEST(f.lot_issued_qty - f.lot_in_before, 0))
               + f.batch_issued_qty + f.direct_issued_qty) AS issued_qty
        FROM fifo f
    ),
    s AS (
      SELECT c.*,
             GREATEST(c.net_in_qty - c.issued_qty, 0) AS stock_qty,
             CASE
               WHEN c.qc_status = 'REJECTED'                         THEN 'REJECTED'
               WHEN c.qc_status = 'PENDING'                          THEN 'PENDING'
               WHEN c.qc_status = 'HOLD' AND c.accepted_qty <= 0     THEN 'HOLD'
               WHEN c.net_in_qty - c.issued_qty <= 0.0005            THEN 'CLOSED'
               WHEN c.issued_qty > 0                                 THEN 'PARTIAL'
               ELSE 'AVAILABLE'
             END AS stock_status
        FROM calc c
    )
    SELECT s.*, s.stock_qty AS balance_qty
      FROM s
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.grn_date DESC, s.id DESC
  `, [companyId, ...lotIssue.params, ...filterParams]);
  return rows;
}

fabricYarnProcurementRouter.get('/yarn-stock', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const q = yarnStockQuery.parse(req.query);
  const rows = await yarnStockRows(companyId, q);

  // Dropdown options come from the whole company's yarn stock so choosing one
  // filter never makes the other choices disappear.
  const facets = await query<any>(`
    SELECT DISTINCT ${TRACE_IO_NO} AS io_no, ${TRACE_STYLE_ID} AS style_id, st.style_code, st.style_name
      FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
     WHERE grn.company_id = ? AND gl.material_type = 'YARN' AND gl.yarn_id IS NOT NULL
  `, [companyId]);

  res.json({ data: rows, facets: buildTraceFacets(facets) });
}));

/**
 * GET /api/yarn-stock/:id/bins
 * Bins of the warehouse the yarn lot sits in — feeds the bin assignment modal
 * without requiring WAREHOUSE master rights.
 */
fabricYarnProcurementRouter.get('/yarn-stock/:id/bins', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid yarn stock id');

  const line = await queryOne<any>(`
    SELECT gl.id, grn.warehouse_id FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
     WHERE gl.id = ? AND grn.company_id = ? AND gl.material_type = 'YARN'
  `, [id, companyId]);
  if (!line) throw NotFound('Yarn stock entry not found');

  const bins = await query<any>(`
    SELECT wb.id, wb.bin_code, wb.rack, wb.warehouse_id, wh.warehouse_name
      FROM mst_warehouse_bin wb
      JOIN mst_warehouse wh ON wh.id = wb.warehouse_id
     WHERE wb.warehouse_id = ? AND wh.company_id = ? AND wb.is_active = 1
     ORDER BY wb.rack, wb.bin_code
  `, [line.warehouse_id, companyId]);

  res.json({ data: bins });
}));

/**
 * POST /api/yarn-stock/:id/bin
 * Assign (or clear, with bin_id = null) the bin/rack of a yarn GRN lot line.
 * The bin must belong to the GRN's own warehouse.
 */
const yarnBinSchema = z.object({
  bin_id: z.coerce.number().int().positive().nullable(),
});

fabricYarnProcurementRouter.post('/yarn-stock/:id/bin', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid yarn stock id');
  const body = yarnBinSchema.parse(req.body ?? {});

  const result = await transaction(async (tx) => {
    const line = await txQueryOne<any>(tx, `
      SELECT gl.id, gl.bin_id, grn.warehouse_id, grn.grn_no, gl.lot_no
        FROM trx_grn_line gl
        JOIN trx_grn grn ON grn.id = gl.grn_id
       WHERE gl.id = ? AND grn.company_id = ? AND gl.material_type = 'YARN'
       FOR UPDATE
    `, [id, companyId]);
    if (!line) throw NotFound('Yarn stock entry not found');

    let bin: any = null;
    if (body.bin_id != null) {
      bin = await txQueryOne<any>(tx, `
        SELECT wb.id, wb.bin_code, wb.warehouse_id, wb.is_active
          FROM mst_warehouse_bin wb
          JOIN mst_warehouse wh ON wh.id = wb.warehouse_id
         WHERE wb.id = ? AND wh.company_id = ?
      `, [body.bin_id, companyId]);
      if (!bin) throw BadRequest('Bin not found');
      if (Number(bin.warehouse_id) !== Number(line.warehouse_id)) {
        throw BadRequest(`Bin ${bin.bin_code} is not in the warehouse of GRN ${line.grn_no}`);
      }
      if (!Number(bin.is_active)) throw BadRequest(`Bin ${bin.bin_code} is inactive`);
    }

    await txExecute(tx, `UPDATE trx_grn_line SET bin_id = ? WHERE id = ?`, [body.bin_id, id]);
    await audit(req, 'trx_grn_line', id, 'UPDATE', { bin_id: line.bin_id }, { bin_id: body.bin_id }, tx);
    return { id, bin_id: body.bin_id, location_bin: bin?.bin_code ?? null };
  });

  res.json({ data: { success: true, ...result } });
}));

/* ==============================================================================
   PART B: YARN PURCHASE & YARN GRN (GREY / DYED, DIRECT KG / PACK-BAG)
   ============================================================================== */

/**
 * 5. POST /api/yarn-purchase-orders/convert-from-quotation
 * Converts a Yarn quotation into a Yarn PO (supplier, currency, job / IO, yarn master, count,
 * colour, qty, confirm rate, GST). Count / category / composition missing on the quotation
 * line come from the yarn master.
 */
fabricYarnProcurementRouter.post('/yarn-purchase-orders/convert-from-quotation', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const body = convertQuotationSchema.parse(req.body);
  await assertQuotationNotConverted(companyId, body.quotation_id);
  const info = await loadQuotationForPo(companyId, body.quotation_id, 'YARN');

  const ids = info.lines.map((l) => l.material_id).filter(Boolean);
  const masters = ids.length ? await query<any>(
    `SELECT y.id, y.yarn_name, y.count_value, y.count_type, y.yarn_type, y.base_uom, y.hsn_code,
            comp.description AS composition
       FROM mst_yarn y
       LEFT JOIN mst_composition comp ON comp.id = y.composition_id
      WHERE y.id IN (?)`, [ids]) : [];
  const master = new Map(masters.map((y) => [Number(y.id), y]));

  const prepared = info.lines.map((ql) => {
    const y = ql.material_id ? master.get(Number(ql.material_id)) : null;
    const uomId = ql.uom_id || y?.base_uom || null;
    if (!uomId) throw BadRequest(`Quotation line "${ql.description || `#${ql.id}`}" has no UOM`);
    const colorName = ql.line_color_name || null;
    const count = ql.yarn_count || (y?.count_value ? `${y.count_value}${y.count_type && y.count_type !== 'Ne' ? ` ${y.count_type}` : ''}` : null);
    return { ql, y, uomId, colorName, count, t: quoteLineTax(ql, info.isInterstate) };
  });
  const sums = prepared.reduce((a, p) => ({
    amount: a.amount + p.t.amount, cgst: a.cgst + p.t.cgst, sgst: a.sgst + p.t.sgst, igst: a.igst + p.t.igst,
  }), { amount: 0, cgst: 0, sgst: 0, igst: 0 });

  let poNo = '';
  const poId = await transaction(async (tx) => {
    poNo = await nextDocNumber(tx, companyId, 'PURCHASE_ORDER');
    const newPoId = await insertPoFromQuotation(tx, req, info, poNo, body, sums, 'Yarn');
    for (const { ql, y, uomId, colorName, count, t } of prepared) {
      await txExecute(tx, `
        INSERT INTO trx_purchase_order_line (
          po_id, so_id, style_id, material_type, yarn_id, color_id, color_name, description, hsn_code,
          yarn_type, purchase_basis, yarn_count_str, yarn_category, composition, shade_code,
          qty, uom_id, rate, amount, taxable_amount, gst_rate,
          cgst_rate, cgst_amount, sgst_rate, sgst_amount, igst_rate, igst_amount, tax_amount, net_amount, received_qty
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, [
        newPoId, ql.so_id ?? null, ql.style_id ?? null, 'YARN', ql.material_id ?? null, ql.color_id ?? null, colorName,
        (ql.description || y?.yarn_name || '').slice(0, 255) || null, y?.hsn_code ?? null,
        colorName ? 'Dyed Yarn' : 'Grey Yarn', 'DIRECT_KG', count,
        titleCase(ql.yarn_type || y?.yarn_type), y?.composition ?? null, colorName,
        t.qty, uomId, t.rate, t.amount, t.amount, t.gstRate,
        t.cgstRate, t.cgst, t.sgstRate, t.sgst, t.igstRate, t.igst, t.tax, t.net,
      ]);
    }
    await markQuotationConverted(tx, info.quote.id, poNo);
    await assertPoExcessById(tx, companyId, Number(newPoId));
    return newPoId;
  });

  await audit(req, 'trx_purchase_order', poId, 'INSERT', null, { po_no: poNo, quotation_id: body.quotation_id });
  res.json({ data: { id: poId, po_no: poNo, unresolved_lines: info.unresolved } });
}));

/**
 * 6. POST /api/yarn-grns
 * Creates a Yarn GRN and updates stock ledger in KG
 */
fabricYarnProcurementRouter.post('/yarn-grns', requirePermission('GRN.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  let finalGrnNo = body.grn_no;

  const grnId = await transaction(async (tx) => {
    if (!finalGrnNo) {
      finalGrnNo = await nextDocNumber(tx, companyId, 'GRN');
    }

    // 1. Calculate totals across lines
    const lines = Array.isArray(body.lines) ? body.lines : [];
    let totTaxable = 0;
    let totCgst = 0;
    let totSgst = 0;
    let totIgst = 0;
    const isInterstate = Boolean(body.is_interstate);

    const calculatedLines = lines.map((line: any) => {
      const recKg = Number(line.received_qty) || 0;
      const accKg = Number(line.accepted_qty !== undefined ? line.accepted_qty : recKg);
      const rejKg = Number(line.rejected_qty) || 0;
      const holdKg = Number(line.hold_qty) || 0;
      const poKg = Number(line.po_qty) || recKg;
      const balanceKg = Math.max(0, poKg - accKg);
      const rate = Number(line.rate) || 0;
      const taxable = Number(line.taxable_amount !== undefined ? line.taxable_amount : (accKg * rate));
      const gstRate = Number(line.gst_rate !== undefined ? line.gst_rate : 5);

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      if (isInterstate) {
        igst = Number(((taxable * gstRate) / 100).toFixed(4));
      } else {
        cgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
        sgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
      }
      const taxAmt = cgst + sgst + igst;
      const lineTotal = taxable + taxAmt;

      totTaxable += taxable;
      totCgst += cgst;
      totSgst += sgst;
      totIgst += igst;

      return {
        ...line,
        recKg,
        accKg,
        rejKg,
        holdKg,
        balanceKg,
        rate,
        taxable,
        gstRate,
        cgst,
        sgst,
        igst,
        taxAmt,
        lineTotal,
      };
    });

    const totTax = totCgst + totSgst + totIgst;
    const netAmount = totTaxable + totTax;

    // Common invoice summary: landed heads, ± other charges, TCS (+), TDS (−), round off.
    const summary = computeInvoice(
      calculatedLines.map((l: any) => ({ taxable: l.taxable, tax: l.taxAmt })),
      isInterstate ? 'INTER_STATE' : 'INTRA_STATE',
      chargesFromRow(body, 'tcs_rate'),
    );
    const summaryCols = invoiceSummaryColumns(body, summary, 'tcs_rate');
    const freightCharges = summaryCols.freight_charges;
    const otherCharges = summaryCols.other_charges;
    const roundOff = summary.roundOff;
    const tcsRate = Number(summaryCols.tcs_rate) || 0;
    const tcsApplicable = tcsRate > 0;
    const tcsSection = tcsApplicable ? (body.tcs_section || '206C(1H)') : null;
    const tcsAmount = summary.tcs;
    const grandTotal = summary.net;

    // every inward is mapped to its security gate entry (client voice note 02-Oct-2026)
    if (!body.gate_inward_id && await settingFlag(companyId, 'GATE_ENTRY_REQUIRED_FOR_INWARD', false)) throw BadRequest('Map the gate entry of this GRN (security gate entry is required for every inward)');
    const poIds = Array.isArray(body.po_ids)
      ? body.po_ids.map(Number).filter((n: number) => n > 0)
      : (body.po_id ? [Number(body.po_id)] : []);
    const primaryPoId = poIds[0] || (body.po_id ? Number(body.po_id) : null);
    const poIdsJson = poIds.length > 0 ? JSON.stringify(poIds) : null;

    const grnRes = await txExecute(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, po_ids, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, is_interstate,
        taxable_amount, tax_amount, cgst_amount, sgst_amount, igst_amount, net_amount,
        freight_charges, other_charges, round_off,
        tcs_applicable, tcs_section, tcs_rate, tcs_amount, grand_total,
        remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || null,   // no fake IO — the job comes from the PO / GRN line
      body.grn_date || new Date().toISOString().slice(0, 10),
      primaryPoId,
      poIdsJson,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      isInterstate ? 1 : 0,
      totTaxable,
      totTax,
      totCgst,
      totSgst,
      totIgst,
      netAmount,
      freightCharges,
      otherCharges,
      roundOff,
      tcsApplicable ? 1 : 0,
      tcsSection,
      tcsRate,
      tcsAmount,
      grandTotal,
      body.remarks || null,
      userId,
    ]);

    const newGrnId = grnRes!.insertId;
    await txExecute(tx, 'UPDATE trx_grn SET receipt_type = ? WHERE id = ?', [body.receipt_type === 'FINAL' ? 'FINAL' : (primaryPoId ? 'PARTIAL' : null), newGrnId]);
    await txExecute(tx, `
      UPDATE trx_grn SET insurance = ?, customs_duty = ?, clearing_charges = ?,
             other_charges_sign = ?, other_charges_label = ?,
             tds_section = ?, tds_pct = ?, tds_amount = ?
       WHERE id = ?
    `, [summaryCols.insurance, summaryCols.customs_duty, summaryCols.clearing_charges,
        summaryCols.other_charges_sign, summaryCols.other_charges_label,
        summaryCols.tds_section, summaryCols.tds_pct, summaryCols.tds_amount, newGrnId]);

    // the gate entry must be this supplier's (and not cancelled); it is marked GRN completed
    if (body.gate_inward_id) await useGateEntry(tx, companyId, { gate_inward_id: Number(body.gate_inward_id), party_id: Number(body.supplier_id) || null, label: 'Yarn GRN' });

    for (const line of calculatedLines) {
      const linePoId = line.po_id ? Number(line.po_id) : primaryPoId;
      await txExecute(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_id, po_line_id, so_id, style_id, material_type, yarn_id,
          yarn_type, yarn_count_str, shade_code, color_name,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          rate, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, total_amount,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        linePoId,
        line.po_line_id ? Number(line.po_line_id) : null,
        line.so_id ? Number(line.so_id) : (body.so_id ? Number(body.so_id) : null),
        line.style_id ? Number(line.style_id) : (body.style_id ? Number(body.style_id) : null),
        'YARN',
        Number(line.yarn_id),
        line.yarn_type || 'Grey Yarn',
        line.yarn_count_str || null,
        line.shade_code || null,
        line.color_name || null,
        line.recKg,
        line.recKg,
        Number(line.packs || line.no_of_rolls || 1),
        line.accKg,
        line.rejKg,
        line.holdKg,
        line.balanceKg,
        line.rate,
        line.taxable,
        line.gstRate,
        line.cgst,
        line.sgst,
        line.igst,
        line.lineTotal,
        // a blank lot gets a GRN-unique lot no (a shared default lot broke lot traceability)
        line.lot_no || `${finalGrnNo}-Y${Number(line.yarn_id)}`,
        line.qc_status || body.qc_status || 'ACCEPTED',
        5, // KG
      ]);

      if (line.po_line_id) {
        await txExecute(tx, `
          UPDATE trx_purchase_order_line
             SET received_qty = COALESCE(received_qty, 0) + ?
           WHERE id = ?
        `, [line.accKg, line.po_line_id]);
        if (body.receipt_type === 'FINAL') await closePoLinesShort(tx, 'PO', [Number(line.po_line_id)], newGrnId);
      }

      if (line.accKg > 0 && body.qc_status !== 'REJECTED') {
        await txExecute(tx, `
          INSERT INTO trx_stock_ledger (
            company_id, warehouse_id, material_type, yarn_id,
            txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          Number(body.warehouse_id),
          'YARN',
          Number(line.yarn_id),
          'GRN',
          'GRN',
          newGrnId,
          line.accKg,
          0,
          5, // KG
          Number(line.rate || 0),
        ]);
      }
    }

    // yarn count as ordered on the PO (else the yarn master's count) when the screen did not send it
    await txExecute(tx, `UPDATE trx_grn_line gl LEFT JOIN trx_purchase_order_line pl ON pl.id = gl.po_line_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
        SET gl.yarn_count_str = COALESCE(NULLIF(pl.yarn_count_str, ''), NULLIF(TRIM(CONCAT(COALESCE(y.count_value, ''), IF(y.count_value IS NULL, '', CONCAT(' ', COALESCE(y.count_type, 'Ne'))))), ''))
      WHERE gl.grn_id = ? AND (gl.yarn_count_str IS NULL OR gl.yarn_count_str = '')`, [newGrnId]);
    return newGrnId;
  });

  res.json({ data: { id: grnId, grn_no: finalGrnNo } });
}));

/**
 * GET /api/yarn-grns
 */
fabricYarnProcurementRouter.get('/yarn-grns', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const rows = await query<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no,
           COALESCE((SELECT SUM(gl.received_qty) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN'), 0) AS total_kg,
           COALESCE((SELECT SUM(gl.no_of_rolls) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN'), 0) AS total_packs
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.company_id = ?
       AND (EXISTS (SELECT 1 FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN')
            OR po.po_no LIKE 'YPO%' OR g.grn_no LIKE 'YGRN%')
     ORDER BY g.id DESC
  `, [companyId]);
  res.json({ data: rows });
}));

/**
 * GET /api/yarn-grns/:id
 */
fabricYarnProcurementRouter.get('/yarn-grns/:id', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const grn = await queryOne<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.id = ? AND g.company_id = ?
  `, [id, companyId]);

  if (!grn) throw NotFound('Yarn GRN not found');

  const lines = await query<any>(`
    SELECT gl.*, po.po_no, y.yarn_name, y.yarn_code, comp.description AS composition, y.yarn_type AS yarn_base_type, COALESCE(gl.yarn_type, 'Grey Yarn') AS yarn_type, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN trx_purchase_order po ON po.id = gl.po_id
      LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
      LEFT JOIN mst_composition comp ON comp.id = y.composition_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [id]);

  res.json({ data: { ...grn, lines } });
}));

