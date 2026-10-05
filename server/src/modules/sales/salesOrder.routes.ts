import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Conflict } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';

export const salesOrderRouter = Router();

const INCOTERM = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'] as const;
const PAYMENT  = ['LC','TT_ADVANCE','TT_AGAINST_DOC','DA','DP','CAD','OPEN'] as const;
const ORDER_TYPES = ['SAMPLE','PROJECTION','DOMESTIC','EXPORT'] as const;

/** Order type initial used in the SO number (G11 **E** 26 CAPE 0570). */
const ORDER_TYPE_INITIAL: Record<(typeof ORDER_TYPES)[number], string> = {
  EXPORT: 'E', DOMESTIC: 'D', PROJECTION: 'P', SAMPLE: 'S',
};
/** Merchandiser group: always "G" + 2 digits (G01 .. G99). */
const GROUP_RE = /^G\d{2}$/;
const groupCode = () => z.union([
  z.string().trim().toUpperCase().regex(GROUP_RE, 'Use G + 2 digits, e.g. G11'), z.literal(''), z.null(),
]).transform((v) => (v === '' ? null : v)).nullish();

const skuLineSchema = z.object({
  sku_id: s.idReq(),
  qty: z.coerce.number().int().min(0),
  /**
   * Size-wise excess (cutting buffer) %. Null/absent = inherit the line's
   * excess %, which itself falls back to the order header's.
   */
  excess_pct: z.coerce.number().min(0, 'Size excess % cannot be negative')
    .max(100, 'Size excess % cannot exceed 100').nullish(),
});

const lineSchema = z.object({
  style_id: s.idReq(),
  color_id: s.id(),
  /** Assort colour entered on the order, carried alongside the colour downstream. */
  assort_color: s.nullableStr(80),
  /** Garment part this line covers: TOP / BOTTOM / COLLAR / CUFF / FOLDING */
  part_name: z.enum(['TOP', 'BOTTOM', 'COLLAR', 'CUFF', 'FOLDING', 'OTHER']).nullable().optional(),
  description: s.nullableStr(255),
  unit_price: z.coerce.number().min(0),
  excess_pct: s.dec(),
  plan_cut_qty: z.coerce.number().int().min(0).optional(),
  ship_date: s.date(),
  /** Size-wise breakdown. Line order_qty is derived from the sum. */
  skus: z.array(skuLineSchema).default([]),
  /** Used only when no size breakdown is supplied. */
  order_qty: z.coerce.number().int().min(0).optional(),
});

const soSchema = z.object({
  branch_id: s.id(),
  so_no: s.nullableStr(40),
  io_no: s.nullableStr(60),
  order_type: z.enum(ORDER_TYPES).nullish(),
  so_date: s.date(),
  buyer_id: s.idReq(),
  agent_id: s.id(),
  merchandiser_id: s.id(),
  /** Merchandiser group (G01..G99) — the first block of the SO number. */
  order_group: groupCode(),
  quotation_id: s.id(),
  buyer_po_no: s.nullableStr(60),
  buyer_po_date: s.date(),
  season: s.nullableStr(40),
  currency_id: s.idReq(),
  exchange_rate: s.dec(),
  incoterm: z.enum(INCOTERM).nullish(),
  port_of_loading: s.nullableStr(80),
  destination_country: s.id(),
  destination_port: s.nullableStr(80),
  payment_term: z.enum(PAYMENT).nullish(),
  lc_no: s.nullableStr(60), lc_date: s.date(), lc_expiry: s.date(),
  excess_pct: s.dec(),
  tolerance_plus_pct: s.dec(),
  tolerance_minus_pct: s.dec(),
  ship_date: s.date(), delivery_date: s.date(),
  status_id: s.id(),
  remarks: s.text(),
  lines: z.array(lineSchema).default([]),
});

/** A confirmed order is protected from casual edits. */
const LOCKED_STATES = ['APPROVED', 'CLOSED', 'CANCELLED'];

async function loadLines(id: number) {
  const lines = await query<any>(
    `SELECT l.*, st.style_code, st.style_name, c.color_name, c.color_code, l.part_name
       FROM trx_sales_order_line l
       LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN mst_color c  ON c.id  = l.color_id
      WHERE l.so_id = ? ORDER BY l.id`, [id]);

  for (const l of lines) {
    l.skus = await query(
      `SELECT ss.*, k.sku_code, k.barcode, k.color_id, k.size_id, c.color_name, sz.size_code, sz.size_label, sz.sort_order
         FROM trx_sales_order_sku ss
         JOIN mst_style_sku k ON k.id = ss.sku_id
         JOIN mst_color c     ON c.id = k.color_id
         JOIN mst_size sz     ON sz.id = k.size_id
        WHERE ss.so_line_id = ? ORDER BY sz.sort_order, sz.id`, [l.id]);
  }
  return lines;
}

/**
 * Assort colour of an order line, matched the way downstream screens know a
 * job: IO number + style + colour. Returns null when none was entered.
 */
export async function assortColorFor(companyId: number, ioNo: string, styleId: number, colorId: number | null) {
  const row = await queryOne<{ assort_color: string | null }>(
    `SELECT l.assort_color
       FROM trx_sales_order_line l
       JOIN trx_sales_order so ON so.id = l.so_id
      WHERE so.company_id = ? AND so.io_no = ? AND so.is_deleted = 0
        AND l.style_id = ? AND (l.color_id <=> ?) AND l.assort_color IS NOT NULL
      ORDER BY l.id LIMIT 1`, [companyId, ioNo, styleId, colorId]);
  return row?.assort_color ?? null;
}

/** Recalculate header order_qty / total_amount / plan_cut_qty from the persisted lines. */
async function recalcHeader(tx: Tx, soId: number) {
  const agg = await txQueryOne<{ qty: number; amt: number; plan_cut: number }>(
    tx,
    `SELECT COALESCE(SUM(order_qty),0) AS qty,
            COALESCE(SUM(amount),0) AS amt,
            COALESCE(SUM(plan_cut_qty),0) AS plan_cut
       FROM trx_sales_order_line WHERE so_id = ?`, [soId]);
  await txExecute(tx,
    `UPDATE trx_sales_order SET order_qty = ?, total_amount = ?, plan_cut_qty = ? WHERE id = ?`,
    [agg?.qty ?? 0, agg?.amt ?? 0, agg?.plan_cut ?? (agg?.qty ?? 0), soId]);
}

async function writeLines(tx: Tx, soId: number, lines: z.infer<typeof lineSchema>[], headerExcessPct = 0) {
  for (const l of lines) {
    const skuQty = l.skus.reduce((a, x) => a + x.qty, 0);
    const qty = l.skus.length ? skuQty : (l.order_qty ?? 0);
    if (qty <= 0) throw BadRequest('Each order line needs a quantity greater than zero');
    const amount = Number((qty * l.unit_price).toFixed(4));
    const excessPct = Number(l.excess_pct !== undefined && l.excess_pct !== null ? l.excess_pct : headerExcessPct);

    // Per-size plan cut: size % → line % → header %. When any size carries its
    // own %, the line plan cut is the sum of the size plan cuts; otherwise the
    // line keeps its original behaviour (explicit plan_cut_qty or qty × line %).
    const sizeRows = l.skus.filter((sk) => sk.qty > 0).map((sk) => {
      const pct = sk.excess_pct !== undefined && sk.excess_pct !== null ? Number(sk.excess_pct) : (excessPct || 0);
      return { ...sk, planCut: Math.round(sk.qty * (1 + pct / 100)) };
    });
    const hasSizeExcess = sizeRows.some((sk) => sk.excess_pct !== undefined && sk.excess_pct !== null);
    const planCutQty = hasSizeExcess
      ? sizeRows.reduce((a, sk) => a + sk.planCut, 0)
      : l.plan_cut_qty && l.plan_cut_qty > 0
        ? l.plan_cut_qty
        : Math.round(qty * (1 + (excessPct || 0) / 100));

    const r = await txExecute(tx,
      `INSERT INTO trx_sales_order_line
         (so_id, style_id, color_id, assort_color, part_name, description, order_qty, excess_pct, plan_cut_qty, unit_price, amount, ship_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [soId, l.style_id, l.color_id ?? null, l.assort_color ?? null, l.part_name ?? null, l.description ?? null, qty, excessPct, planCutQty, l.unit_price, amount,
       l.ship_date ?? null]);

    for (const sk of sizeRows) {   // empty cells in the size grid are skipped
      // the size must be a size of this style (and colour, when the line has one) — size doc §13
      const ok = await txQueryOne<any>(tx, `SELECT 1 x FROM mst_style_sku WHERE id = ? AND style_id = ? AND (? IS NULL OR color_id = ?)`,
        [sk.sku_id, l.style_id, l.color_id ?? null, l.color_id ?? null]);
      if (!ok) throw BadRequest(`Size / SKU #${sk.sku_id} is not a size of this style${l.color_id ? ' and colour' : ''}`);
      await txExecute(tx,
        `INSERT INTO trx_sales_order_sku (so_line_id, sku_id, qty, excess_pct, plan_cut_qty) VALUES (?,?,?,?,?)`,
        [r.insertId, sk.sku_id, sk.qty, sk.excess_pct ?? null, sk.planCut]);
    }
  }
}

// ---------------------------------------------------------------- LIST
salesOrderRouter.get('/', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    buyer_id: z.coerce.number().int().optional(),
    status_id: z.coerce.number().int().optional(),
    approval_state: z.string().optional(),
    season: z.string().optional(),
    dateFrom: z.string().optional(), dateTo: z.string().optional(),
  }).parse(req.query);

  const where = ['t.company_id = ?', 't.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (q.q) {
    where.push('(t.so_no LIKE ? OR t.io_no LIKE ? OR t.buyer_po_no LIKE ? OR b.party_name LIKE ? OR mer.party_name LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.buyer_id) { where.push('t.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.approval_state) { where.push('t.approval_state = ?'); params.push(q.approval_state); }
  for (const k of ['branch_id', 'agent_id', 'merchandiser_id', 'status_id', 'currency_id', 'season', 'order_type'] as const) {
    if ((q as any)[k]) { where.push(`t.${k} = ?`); params.push((q as any)[k]); }
  }
  if (q.dateFrom) { where.push('t.so_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('t.so_date <= ?'); params.push(q.dateTo); }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(
      `SELECT t.*, b.party_name AS buyer_name, ag.party_name AS agent_name,
              mer.party_name AS merchandiser_name,
              cur.code AS currency_code, cs.label AS status_label, dc.name AS destination_name,
              (SELECT COALESCE(SUM(po.produced_qty),0) FROM trx_production_order po
                WHERE po.so_id = t.id) AS produced_qty
         FROM trx_sales_order t
         LEFT JOIN mst_party b   ON b.id  = t.buyer_id
         LEFT JOIN mst_party ag  ON ag.id = t.agent_id
         LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id
         LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
         LEFT JOIN cfg_status cs ON cs.id = t.status_id
         LEFT JOIN cfg_country dc ON dc.id = t.destination_country
        WHERE ${clause} ORDER BY t.so_date DESC, t.id DESC
        LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_sales_order t LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id LEFT JOIN mst_party b ON b.id = t.buyer_id WHERE ${clause}`, params),
  ]);

  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

// ------------------------------------------------------------ SO NUMBER
// Legacy format: <group><type initial><yy><buyer prefix><4-digit running no>,
// e.g. G11E26CAPE0570. The running number is per company per year and lives
// in cfg_so_number_seq; the IO number is generated separately below.

type One = <T>(sql: string, params: unknown[]) => Promise<T | null>;

interface SoNumberInput {
  order_group?: string | null;
  merchandiser_id?: number | null;
  order_type?: string | null;
  so_date?: string | null;
  buyer_id?: number | null;
}

/**
 * Merchandiser group for the SO number: picked on the order, else the
 * merchandiser's group, else the company default (setting SO_DEFAULT_GROUP),
 * so an order is never blocked only because a group was not set up.
 */
async function resolveOrderGroup(one: One, companyId: number, h: SoNumberInput) {
  let group = h.order_group?.trim().toUpperCase() || null;
  if (!group && h.merchandiser_id) {
    const m = await one<{ group_code: string | null }>(
      `SELECT group_code FROM mst_party WHERE id = ? AND company_id = ?`, [h.merchandiser_id, companyId]);
    group = m?.group_code?.trim().toUpperCase() || null;
  }
  if (!group) {
    const d = await one<{ setting_value: string | null }>(
      `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'SO_DEFAULT_GROUP'`, [companyId]);
    group = d?.setting_value?.trim().toUpperCase() || null;
  }
  return group && GROUP_RE.test(group) ? group : null;
}

/** Resolve the fixed part of the SO number (everything but the running number). */
async function soNumberStem(one: One, companyId: number, h: SoNumberInput) {
  const group = await resolveOrderGroup(one, companyId, h);
  if (!group) return null;

  let prefix = '';
  if (h.buyer_id) {
    const b = await one<{ io_prefix: string | null; party_name: string | null }>(
      `SELECT io_prefix, party_name FROM mst_party WHERE id = ? AND company_id = ?`, [h.buyer_id, companyId]);
    prefix = (b?.io_prefix ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
      || (b?.party_name ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
  }
  if (!prefix) return null;

  const initial = ORDER_TYPE_INITIAL[(h.order_type ?? 'EXPORT') as keyof typeof ORDER_TYPE_INITIAL] ?? 'E';
  const yy = (h.so_date && /^\d{4}/.test(h.so_date) ? h.so_date.slice(2, 4)
    : String(new Date().getFullYear()).slice(2));
  return { stem: `${group}${initial}${yy}${prefix}`, yy };
}

const soNumberHint = 'Pick the buyer to auto-generate the SO number (group: order → merchandiser → company default)';

/**
 * Take the next SO number inside the transaction. The sequence row is locked
 * FOR UPDATE, so concurrent orders never share a number; a number already
 * used (e.g. keyed in manually) is skipped.
 */
async function nextSoNumber(tx: Tx, companyId: number, h: SoNumberInput): Promise<string> {
  const parts = await soNumberStem((sql, p) => txQueryOne(tx, sql, p), companyId, h);
  if (!parts) {
    const group = await resolveOrderGroup((sql, p) => txQueryOne(tx, sql, p), companyId, h);
    if (!group) {
      throw BadRequest('No merchandiser group — pick one on the order, set it on the merchandiser, or set the company default (SO_DEFAULT_GROUP)',
        [{ field: 'order_group', message: 'Select the merchandiser group' }]);
    }
    throw BadRequest('Choose the buyer — its I/O prefix (or name) forms the SO number', [{ field: 'buyer_id', message: 'Select the buyer' }]);
  }

  // Upsert takes the row's exclusive lock straight away (INSERT IGNORE would
  // take a shared lock and deadlock concurrent orders on the FOR UPDATE).
  await txExecute(tx,
    `INSERT INTO cfg_so_number_seq (company_id, yy, next_number) VALUES (?,?,1)
     ON DUPLICATE KEY UPDATE next_number = next_number`, [companyId, parts.yy]);
  const row = await txQueryOne<{ next_number: number }>(tx,
    `SELECT next_number FROM cfg_so_number_seq WHERE company_id = ? AND yy = ? FOR UPDATE`, [companyId, parts.yy]);
  let n = row?.next_number ?? 1;
  for (;; n++) {
    if (n > 9999) throw Conflict(`SO running number for 20${parts.yy} has passed 9999`);
    const soNo = `${parts.stem}${String(n).padStart(4, '0')}`;
    const dup = await txQueryOne(tx,
      `SELECT id FROM trx_sales_order WHERE company_id = ? AND so_no = ?`, [companyId, soNo]);
    if (!dup) {
      await txExecute(tx, `UPDATE cfg_so_number_seq SET next_number = ? WHERE company_id = ? AND yy = ?`,
        [n + 1, companyId, parts.yy]);
      return soNo;
    }
  }
}

/** Preview of the next SO number for the New Sales Order screen (nothing is consumed). */
salesOrderRouter.get('/next-so-number', requirePermission('SALES_ORDER.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const q = z.object({
    order_group: z.string().trim().optional(),
    merchandiser_id: z.coerce.number().int().optional(),
    order_type: z.enum(ORDER_TYPES).optional(),
    so_date: z.string().optional(),
    buyer_id: z.coerce.number().int().optional(),
  }).parse(req.query);

  const parts = await soNumberStem((sql, p) => queryOne(sql, p), companyId, q);
  if (!parts) { res.json({ data: { so_no: null, hint: soNumberHint } }); return; }
  const row = await queryOne<{ next_number: number }>(
    `SELECT next_number FROM cfg_so_number_seq WHERE company_id = ? AND yy = ?`, [companyId, parts.yy]);
  const soNo = `${parts.stem}${String(row?.next_number ?? 1).padStart(4, '0')}`;
  res.json({ data: { so_no: soNo, stem: parts.stem } });
}));

// -------------------------------------------------------------- NEXT I/O NUMBER
// Must stay above '/:id' — Express matches in declaration order, and a literal
// path declared after a parameterised one is never reached.
salesOrderRouter.get('/next-io-number', requirePermission('SALES_ORDER.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const buyerId = req.query.buyer_id ? Number(req.query.buyer_id) : null;
  const currentYear = new Date().getFullYear();

  let prefix = 'IO';
  if (buyerId) {
    const buyer = await queryOne<any>(
      `SELECT party_code, legal_name, io_prefix FROM mst_party WHERE id = ? AND company_id = ?`,
      [buyerId, companyId]
    );
    if (buyer) {
      if (buyer.io_prefix && buyer.io_prefix.trim()) {
        prefix = buyer.io_prefix.trim().toUpperCase();
      } else if (buyer.party_code && buyer.party_code.trim()) {
        prefix = buyer.party_code.trim().toUpperCase();
      } else if (buyer.legal_name && buyer.legal_name.trim()) {
        prefix = buyer.legal_name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      }
    }
  }

  const latest = await queryOne<{ cnt: number }>(`
    SELECT COUNT(*) as cnt FROM trx_sales_order
     WHERE company_id = ? AND io_no LIKE ?
  `, [companyId, `${prefix}-%`]);

  const count = (latest?.cnt ?? 0) + 1;
  const seq = String(count).padStart(3, '0');
  const ioNo = `${prefix}-IO-${currentYear}-${seq}`;

  res.json({ data: { io_no: ioNo, prefix } });
}));

// ------------------------------------------------------------- GET ONE
salesOrderRouter.get('/:id', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const so = await queryOne(
    `SELECT t.*, b.party_name AS buyer_name, b.party_code AS buyer_code,
            ag.party_name AS agent_name, mer.party_name AS merchandiser_name, mer.party_code AS merchandiser_code,
            cur.code AS currency_code, cs.label AS status_label, dc.name AS destination_name
       FROM trx_sales_order t
       LEFT JOIN mst_party b   ON b.id  = t.buyer_id
       LEFT JOIN mst_party ag  ON ag.id = t.agent_id
       LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
       LEFT JOIN cfg_country dc ON dc.id = t.destination_country
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!so) throw NotFound('Sales order not found');

  const [lines, prodOrders, invoices] = await Promise.all([
    loadLines(id),
    query(`SELECT id, po_prod_no, style_id, order_qty, produced_qty, approval_state
             FROM trx_production_order WHERE so_id = ? ORDER BY id`, [id]),
    query(`SELECT id, invoice_no, invoice_date, total_value FROM trx_commercial_invoice
            WHERE so_id = ? ORDER BY id`, [id]),
  ]);
  res.json({ data: { ...so, lines, production_orders: prodOrders, invoices } });
}));

async function resolveIoNumber(tx: Tx, companyId: number, buyerId: number, requestedIoNo?: string | null): Promise<string> {
  if (requestedIoNo && requestedIoNo.trim()) return requestedIoNo.trim();
  const currentYear = new Date().getFullYear();
  let prefix = 'IO';
  if (buyerId) {
    const buyer = await txQueryOne<any>(tx,
      `SELECT party_code, legal_name, io_prefix FROM mst_party WHERE id = ? AND company_id = ?`,
      [buyerId, companyId]
    );
    if (buyer) {
      if (buyer.io_prefix && buyer.io_prefix.trim()) {
        prefix = buyer.io_prefix.trim().toUpperCase();
      } else if (buyer.party_code && buyer.party_code.trim()) {
        prefix = buyer.party_code.trim().toUpperCase();
      } else if (buyer.legal_name && buyer.legal_name.trim()) {
        prefix = buyer.legal_name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase();
      }
    }
  }

  const latest = await txQueryOne<{ cnt: number }>(tx, `
    SELECT COUNT(*) as cnt FROM trx_sales_order
     WHERE company_id = ? AND io_no LIKE ?
  `, [companyId, `${prefix}-%`]);

  const count = (latest?.cnt ?? 0) + 1;
  const seq = String(count).padStart(3, '0');
  return `${prefix}-IO-${currentYear}-${seq}`;
}

// -------------------------------------------------------------- CREATE
salesOrderRouter.post('/', requirePermission('SALES_ORDER.CREATE'), ah(async (req, res) => {
  const body = soSchema.parse(req.body);
  if (!body.lines.length) throw BadRequest('A sales order needs at least one line');

  const created = await transaction(async (tx) => {
    const { lines, ...h } = body;
    // Group defaults from the merchandiser, then the company default, when not picked on the order.
    if (!h.order_group) h.order_group = await resolveOrderGroup((sql, p) => txQueryOne(tx, sql, p), req.user!.companyId, h);
    const soNo = body.so_no || await nextSoNumber(tx, req.user!.companyId, h);
    const ioNo = await resolveIoNumber(tx, req.user!.companyId, h.buyer_id, h.io_no);

    const r = await txExecute(tx,
      `INSERT INTO trx_sales_order
        (company_id, branch_id, so_no, io_no, order_type, so_date, buyer_id, agent_id, merchandiser_id, order_group, quotation_id,
         buyer_po_no, buyer_po_date, season, currency_id, exchange_rate, incoterm,
         port_of_loading, destination_country, destination_port, payment_term,
         lc_no, lc_date, lc_expiry, excess_pct, tolerance_plus_pct, tolerance_minus_pct,
         ship_date, delivery_date, status_id,
         approval_state, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
      [req.user!.companyId, h.branch_id ?? null, soNo, ioNo, h.order_type ?? 'EXPORT', h.so_date ?? null, h.buyer_id,
       h.agent_id ?? null, h.merchandiser_id ?? null, h.order_group ?? null, h.quotation_id ?? null, h.buyer_po_no ?? null, h.buyer_po_date ?? null,
       h.season ?? null, h.currency_id, h.exchange_rate ?? 1, h.incoterm ?? 'FOB',
       h.port_of_loading ?? null, h.destination_country ?? null, h.destination_port ?? null,
       h.payment_term ?? 'LC', h.lc_no ?? null, h.lc_date ?? null, h.lc_expiry ?? null,
       h.excess_pct ?? 0, h.tolerance_plus_pct ?? 0, h.tolerance_minus_pct ?? 0,
       h.ship_date ?? null, h.delivery_date ?? null, h.status_id ?? null, h.remarks ?? null,
       req.user!.id]);

    await writeLines(tx, r.insertId, lines, Number(h.excess_pct) || 0);
    await recalcHeader(tx, r.insertId);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_sales_order', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// -------------------------------------------------------------- UPDATE
salesOrderRouter.put('/:id', requirePermission('SALES_ORDER.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');
  if (LOCKED_STATES.includes(before.approval_state)) {
    throw Conflict(`This order is ${before.approval_state.toLowerCase()} and can no longer be edited`);
  }

  const body = soSchema.partial().parse(req.body);
  const after = await transaction(async (tx) => {
    const { lines, ...h } = body;
    const cols: Record<string, unknown> = { ...h, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE trx_sales_order SET ${keys.map((k) => `${k} = ?`).join(', ')}
          WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => cols[k]), id, req.user!.companyId]);
    }
    if (lines) {
      const existing = await txQuery<{ id: number }>(
        tx,
        `SELECT id FROM trx_sales_order_line WHERE so_id = ?`, [id]);
      for (const l of existing) {
        await txExecute(tx, `DELETE FROM trx_sales_order_sku WHERE so_line_id = ?`, [l.id]);
      }
      await txExecute(tx, `DELETE FROM trx_sales_order_line WHERE so_id = ?`, [id]);
      await writeLines(tx, id, lines, Number(h.excess_pct ?? before.excess_pct) || 0);
    }
    await recalcHeader(tx, id);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [id]);
  });

  await audit(req, 'trx_sales_order', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

// ------------------------------------------------------- STATE CHANGES
const stateSchema = z.object({
  approval_state: z.enum(['DRAFT','PENDING','APPROVED','REJECTED','ON_HOLD','CLOSED','CANCELLED']),
  remarks: s.nullableStr(500),
});

salesOrderRouter.post('/:id/approval-state', requirePermission('SALES_ORDER.APPROVE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { approval_state, remarks } = stateSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');

  const after = await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_sales_order SET approval_state = ?, updated_by = ? WHERE id = ?`,
      [approval_state, req.user!.id, id]);
    await txExecute(tx,
      `INSERT INTO trx_status_history (domain, record_id, to_status_id, remarks, changed_by)
       SELECT 'SALES_ORDER', ?, id, ?, ? FROM cfg_status
        WHERE domain = 'SALES_ORDER' AND code = ? LIMIT 1`,
      [id, remarks ?? `State changed to ${approval_state}`, req.user!.id, approval_state]);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [id]);
  });

  await audit(req, 'trx_sales_order', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

salesOrderRouter.delete('/:id', requirePermission('SALES_ORDER.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');

  const used = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trx_production_order WHERE so_id = ?`, [id]);
  if ((used?.n ?? 0) > 0) {
    throw Conflict('This order already has production orders and cannot be deleted. Cancel it instead.');
  }

  await transaction((tx) => txExecute(tx,
    `UPDATE trx_sales_order SET is_deleted = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]));
  await audit(req, 'trx_sales_order', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

/** Size-wise summary across the whole order — used by the packing screens. */
salesOrderRouter.get('/:id/size-summary', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT sz.id AS size_id, sz.size_code, sz.size_label, sz.sort_order,
            c.id AS color_id, c.color_name, SUM(ss.qty) AS qty,
            SUM(COALESCE(ss.plan_cut_qty, ss.qty)) AS plan_cut_qty
       FROM trx_sales_order_sku ss
       JOIN trx_sales_order_line l ON l.id = ss.so_line_id
       JOIN mst_style_sku k ON k.id = ss.sku_id
       JOIN mst_size sz     ON sz.id = k.size_id
       JOIN mst_color c     ON c.id  = k.color_id
      WHERE l.so_id = ?
      GROUP BY sz.id, sz.size_code, sz.size_label, sz.sort_order, c.id, c.color_name
      ORDER BY c.color_name, sz.sort_order`, [id]);
  res.json({ data: rows });
}));
