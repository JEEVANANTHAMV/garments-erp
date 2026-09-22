import { txQueryOne, txExecute, query, type Tx } from '../config/db.js';
import { BadRequest } from './errors.js';

/**
 * Shared engine for the yarn process module.
 *
 * The developer document asks for one common process architecture behind
 * separate process-specific screens (doc §5, §29). Stock check, reservation,
 * issue, receipt and stock posting are therefore implemented once here and
 * reused by yarn processes, knitting programs and collar programs.
 */

/** Which document a reservation / issue / receipt belongs to. */
export type SrcType = 'YARN_PROCESS' | 'KNITTING_PROGRAM' | 'COLLAR_PROGRAM';

/** Status workflow from doc §21. */
export const PROCESS_STATUSES = [
  'DRAFT', 'STOCK_CHECK', 'RESERVED', 'RELEASED', 'MATERIAL_ISSUED',
  'IN_PROGRESS', 'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC',
  'STOCK_POSTED', 'COMPLETED', 'CANCELLED',
] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];

/** Documents in these states are historical and must be revised, not edited (doc §22). */
export const LOCKED_STATUSES: ProcessStatus[] = ['COMPLETED', 'CANCELLED'];

export function assertEditable(status: string, what = 'document') {
  if (LOCKED_STATUSES.includes(status as ProcessStatus)) {
    throw BadRequest(
      `This ${what} is ${status.toLowerCase()} and can no longer be edited. Create a revision instead.`,
    );
  }
}

/* ================================================================
   Stock availability
================================================================ */

/**
 * Physical stock on hand for a yarn, in KG, from the append-only ledger.
 * Reservations deliberately do NOT reduce this — only issues do (doc §12).
 */
export async function yarnStockOnHand(
  companyId: number, yarnId: number, warehouseId?: number | null,
): Promise<number> {
  const rows = await query<{ qty: string | null }>(
    `SELECT COALESCE(SUM(qty_in) - SUM(qty_out), 0) AS qty
       FROM trx_stock_ledger
      WHERE company_id = ? AND yarn_id = ?
        ${warehouseId ? 'AND warehouse_id = ?' : ''}`,
    warehouseId ? [companyId, yarnId, warehouseId] : [companyId, yarnId],
  );
  return Number(rows[0]?.qty ?? 0);
}

/** Quantity already reserved for a yarn across all live reservations. */
export async function yarnReservedQty(companyId: number, yarnId: number): Promise<number> {
  const rows = await query<{ qty: string | null }>(
    `SELECT COALESCE(SUM(reserved_qty_kg - released_qty_kg), 0) AS qty
       FROM trx_process_reservation
      WHERE company_id = ? AND yarn_id = ? AND status IN ('ACTIVE','PARTIAL')`,
    [companyId, yarnId],
  );
  return Number(rows[0]?.qty ?? 0);
}

export interface StockCheckRow {
  yarn_id: number;
  required_qty_kg: number;
  on_hand_kg: number;
  reserved_by_others_kg: number;
  available_kg: number;
  shortage_kg: number;
}

/** Required vs available, per yarn — backs the "stock check" step and doc §28 shortage report. */
export async function checkStock(
  companyId: number,
  lines: { yarn_id: number; required_qty_kg: number }[],
  warehouseId?: number | null,
): Promise<StockCheckRow[]> {
  const out: StockCheckRow[] = [];
  for (const l of lines) {
    if (!l.yarn_id) continue;
    const [onHand, reserved] = await Promise.all([
      yarnStockOnHand(companyId, l.yarn_id, warehouseId),
      yarnReservedQty(companyId, l.yarn_id),
    ]);
    const available = onHand - reserved;
    out.push({
      yarn_id: l.yarn_id,
      required_qty_kg: l.required_qty_kg,
      on_hand_kg: onHand,
      reserved_by_others_kg: reserved,
      available_kg: available,
      shortage_kg: Math.max(0, l.required_qty_kg - available),
    });
  }
  return out;
}

/* ================================================================
   Stock ledger posting
================================================================ */

export const UOM_KG = 5;
export const UOM_PCS = 1;
export const UOM_MTR = 9;

/**
 * Append a movement to the stock ledger. Every stock-affecting step in this
 * module goes through here so postings stay consistent and auditable (doc §29).
 */
export async function postLedger(tx: Tx, m: {
  companyId: number;
  warehouseId: number;
  materialType: 'YARN' | 'FABRIC' | 'TRIM' | 'FINISHED' | 'WIP';
  yarnId?: number | null;
  fabricId?: number | null;
  skuId?: number | null;
  batchId?: number | null;
  txnType: 'ISSUE' | 'PRODUCTION_IN' | 'PRODUCTION_OUT' | 'ADJUST' | 'RETURN';
  refType: string;
  refId: number;
  qtyIn?: number;
  qtyOut?: number;
  uomId: number;
  rate?: number;
  createdBy?: number | null;
}) {
  await txExecute(
    tx,
    `INSERT INTO trx_stock_ledger
       (company_id, warehouse_id, material_type, yarn_id, fabric_id, sku_id, batch_id,
        txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      m.companyId, m.warehouseId, m.materialType,
      m.yarnId ?? null, m.fabricId ?? null, m.skuId ?? null, m.batchId ?? null,
      m.txnType, m.refType, m.refId,
      m.qtyIn ?? 0, m.qtyOut ?? 0, m.uomId, m.rate ?? 0, m.createdBy ?? null,
    ],
  );
}

/* ================================================================
   Process route sequencing (doc §4)
================================================================ */

export interface RouteStep {
  seq_no: number;
  process_type: string;
  is_mandatory: number | boolean;
  default_loss_pct: number;
}

/**
 * Validate that a process fits its route.
 *
 * The route defines the order, so a process claiming step N must (a) actually
 * be the process type the route puts at step N, and (b) not skip a mandatory
 * earlier step that has never been run for the same order.
 *
 * Returns the problems found; an empty array means the process is in sequence.
 */
export async function validateRouteSequence(opts: {
  companyId: number;
  routeId: number;
  routeSeqNo: number;
  processType: string;
  ioNo?: string | null;
  soLineId?: number | null;
  /** Exclude this process when looking for earlier steps (used on update). */
  excludeProcessId?: number | null;
}): Promise<string[]> {
  const problems: string[] = [];

  const steps = await query<RouteStep>(
    `SELECT seq_no, process_type, is_mandatory, default_loss_pct
       FROM mst_process_route_line
      WHERE route_id = ? AND is_active = 1
      ORDER BY seq_no`,
    [opts.routeId],
  );
  if (!steps.length) return ['The selected route has no active steps'];

  const step = steps.find((s) => Number(s.seq_no) === Number(opts.routeSeqNo));
  if (!step) {
    return [`Step ${opts.routeSeqNo} does not exist on this route ` +
            `(it has steps ${steps.map((s) => s.seq_no).join(', ')})`];
  }

  if (step.process_type !== opts.processType) {
    problems.push(
      `Step ${opts.routeSeqNo} of this route is ${step.process_type.replace(/_/g, ' ')}, ` +
      `but this process is ${opts.processType.replace(/_/g, ' ')}`);
  }

  // A step is only "earlier" within the same order, which the I/O number or the
  // sales-order line identifies. Without either there is nothing to compare.
  if (!opts.ioNo && !opts.soLineId) return problems;

  const earlier = steps.filter(
    (s) => Number(s.seq_no) < Number(opts.routeSeqNo) && (s.is_mandatory === 1 || s.is_mandatory === true));

  for (const prior of earlier) {
    // Knitting and collar knitting are separate documents, so a yarn-process
    // route cannot confirm them here; only the yarn processes are checked.
    if (!['YARN_DYEING', 'WINDING', 'TWISTING'].includes(prior.process_type)) continue;

    const params: any[] = [opts.companyId, opts.routeId, prior.seq_no, prior.process_type];
    let sql =
      `SELECT id, status FROM trx_yarn_process
        WHERE company_id = ? AND route_id = ? AND route_seq_no = ? AND process_type = ?
          AND status <> 'CANCELLED'`;
    if (opts.ioNo) { sql += ' AND io_no = ?'; params.push(opts.ioNo); }
    else { sql += ' AND so_line_id = ?'; params.push(opts.soLineId); }
    if (opts.excludeProcessId) { sql += ' AND id <> ?'; params.push(opts.excludeProcessId); }

    const rows = await query<{ id: number; status: string }>(sql + ' LIMIT 1', params);
    if (!rows.length) {
      problems.push(
        `Mandatory step ${prior.seq_no} (${prior.process_type.replace(/_/g, ' ')}) ` +
        `has not been started for this order`);
    }
  }

  return problems;
}

/* ================================================================
   Reservation
================================================================ */

/**
 * Reserve yarn for a document. Reservation is a soft claim: it records intent
 * and blocks the quantity from other reservations, but posts nothing to the
 * ledger, so physical stock is unchanged (doc §12).
 */
export async function reserveYarn(tx: Tx, r: {
  companyId: number;
  srcType: SrcType;
  srcId: number;
  srcLineId?: number | null;
  yarnId: number;
  requiredQtyKg: number;
  reservedQtyKg: number;
  createdBy?: number | null;
}) {
  const existing = await txQueryOne<{ id: number }>(
    tx,
    `SELECT id FROM trx_process_reservation
      WHERE company_id = ? AND src_type = ? AND src_id = ?
        AND (src_line_id <=> ?) AND yarn_id = ? AND status <> 'CANCELLED'
      LIMIT 1`,
    [r.companyId, r.srcType, r.srcId, r.srcLineId ?? null, r.yarnId],
  );

  if (existing) {
    await txExecute(
      tx,
      `UPDATE trx_process_reservation
          SET required_qty_kg = ?, reserved_qty_kg = ?, status = 'ACTIVE'
        WHERE id = ?`,
      [r.requiredQtyKg, r.reservedQtyKg, existing.id],
    );
    return existing.id;
  }

  const res = await txExecute(
    tx,
    `INSERT INTO trx_process_reservation
       (company_id, src_type, src_id, src_line_id, yarn_id,
        required_qty_kg, reserved_qty_kg, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      r.companyId, r.srcType, r.srcId, r.srcLineId ?? null, r.yarnId,
      r.requiredQtyKg, r.reservedQtyKg, r.createdBy ?? null,
    ],
  );
  return res.insertId;
}

/** Consume reservation as material is issued, and close it once fully drawn. */
export async function consumeReservation(tx: Tx, reservationId: number, qtyKg: number) {
  await txExecute(
    tx,
    `UPDATE trx_process_reservation
        SET released_qty_kg = released_qty_kg + ?,
            status = CASE
              WHEN released_qty_kg + ? >= reserved_qty_kg THEN 'CONSUMED'
              ELSE 'PARTIAL' END
      WHERE id = ?`,
    [qtyKg, qtyKg, reservationId],
  );
}
