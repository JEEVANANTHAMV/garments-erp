import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Conflict } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import { jobBomRequirement } from '../bom/bom.routes.js';
import { cellsFor, cellsPlanCut, lineRequirement, type OrderCell } from '../../core/bomRequirement.js';

export const salesOrderRouter = Router();

const INCOTERM = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'] as const;
const PAYMENT  = ['LC','TT_ADVANCE','TT_AGAINST_DOC','DA','DP','CAD','OPEN'] as const;
const ORDER_TYPES = ['SAMPLE','PROJECTION','DOMESTIC','EXPORT','JOB_WORK'] as const;

/** Order type initial used in the SO number (G11 **E** 26 CAPE 0570). */
const ORDER_TYPE_INITIAL: Record<(typeof ORDER_TYPES)[number], string> = {
  EXPORT: 'E', DOMESTIC: 'D', PROJECTION: 'P', SAMPLE: 'S', JOB_WORK: 'J',
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
    `SELECT l.*, st.style_code, st.style_name, c.color_name, c.color_code, l.part_name,
            am.amendment_no
       FROM trx_sales_order_line l
       LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN mst_color c  ON c.id  = l.color_id
       LEFT JOIN trx_sales_order_amendment am ON am.id = l.amendment_id
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
  const agg = await txQueryOne<{ qty: number; amt: number; plan_cut: number; cancelled: number; additional: number }>(
    tx,
    `SELECT COALESCE(SUM(order_qty),0) AS qty,
            COALESCE(SUM(amount),0) AS amt,
            COALESCE(SUM(plan_cut_qty),0) AS plan_cut,
            COALESCE(SUM(cancelled_qty),0) AS cancelled,
            COALESCE(SUM(IF(is_additional = 1, order_qty + cancelled_qty, 0)),0) AS additional
       FROM trx_sales_order_line WHERE so_id = ?`, [soId]);
  await txExecute(tx,
    `UPDATE trx_sales_order SET order_qty = ?, total_amount = ?, plan_cut_qty = ?, cancelled_qty = ?, additional_qty = ? WHERE id = ?`,
    [agg?.qty ?? 0, agg?.amt ?? 0, agg?.plan_cut ?? (agg?.qty ?? 0), agg?.cancelled ?? 0, agg?.additional ?? 0, soId]);
}

interface WrittenLine {
  so_line_id: number; style_id: number; color_id: number | null; qty: number; plan_cut: number;
  skus: { so_sku_id: number; sku_id: number; qty: number; plan_cut: number }[];
}

async function writeLines(tx: Tx, soId: number, lines: z.infer<typeof lineSchema>[], headerExcessPct = 0,
  opts: { amendmentId?: number } = {}): Promise<WrittenLine[]> {
  const written: WrittenLine[] = [];
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
         (so_id, style_id, color_id, assort_color, part_name, description, order_qty, excess_pct, plan_cut_qty, unit_price, amount, ship_date,
          is_additional, amendment_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [soId, l.style_id, l.color_id ?? null, l.assort_color ?? null, l.part_name ?? null, l.description ?? null, qty, excessPct, planCutQty, l.unit_price, amount,
       l.ship_date ?? null, opts.amendmentId ? 1 : 0, opts.amendmentId ?? null]);
    const w: WrittenLine = { so_line_id: Number(r.insertId), style_id: l.style_id, color_id: l.color_id ?? null, qty, plan_cut: planCutQty, skus: [] };
    written.push(w);

    for (const sk of sizeRows) {   // empty cells in the size grid are skipped
      // the size must be a size of this style (and colour, when the line has one) — size doc §13
      const ok = await txQueryOne<any>(tx, `SELECT 1 x FROM mst_style_sku WHERE id = ? AND style_id = ? AND (? IS NULL OR color_id = ?)`,
        [sk.sku_id, l.style_id, l.color_id ?? null, l.color_id ?? null]);
      if (!ok) throw BadRequest(`Size / SKU #${sk.sku_id} is not a size of this style${l.color_id ? ' and colour' : ''}`);
      const rs = await txExecute(tx,
        `INSERT INTO trx_sales_order_sku (so_line_id, sku_id, qty, excess_pct, plan_cut_qty) VALUES (?,?,?,?,?)`,
        [r.insertId, sk.sku_id, sk.qty, sk.excess_pct ?? null, sk.planCut]);
      w.skus.push({ so_sku_id: Number(rs.insertId), sku_id: sk.sku_id, qty: sk.qty, plan_cut: sk.planCut });
    }
  }
  return written;
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
    order_type: z.enum(ORDER_TYPES).optional(),
    dateFrom: z.string().optional(), dateTo: z.string().optional(),
    /** Orders cancelled / closed in a period: closure_type = CANCELLED | SHORT_CLOSED | COMPLETED | ANY. */
    closure_type: z.enum(['CANCELLED', 'SHORT_CLOSED', 'COMPLETED', 'ANY']).optional(),
    closedFrom: z.string().optional(), closedTo: z.string().optional(),
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
  if (q.closure_type === 'ANY') where.push('t.closure_type IS NOT NULL');
  else if (q.closure_type) { where.push('t.closure_type = ?'); params.push(q.closure_type); }
  if (q.closedFrom) { where.push('t.closed_date >= ?'); params.push(q.closedFrom); }
  if (q.closedTo)   { where.push('t.closed_date <= ?'); params.push(q.closedTo); }
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

/**
 * SO_NUMBER_FORMAT setting:
 *  - DEFAULT: <group><type><yy of SO date><buyer I/O prefix><4-digit no>, running no per calendar year (cfg_so_number_seq).
 *  - TEAM_TYPE_FY_BUYER_JOB: <team><type><FY start yy><3-letter buyer short code><4-digit job no>, e.g. G01E26ACT0001,
 *    running no per financial year (April–March) in cfg_so_number_seq_fy.
 */
type SoNumberFormat = 'DEFAULT' | 'TEAM_TYPE_FY_BUYER_JOB';
async function soNumberFormat(one: One, companyId: number): Promise<SoNumberFormat> {
  const r = await one<{ setting_value: string | null }>(
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'SO_NUMBER_FORMAT'`, [companyId]);
  return String(r?.setting_value ?? '').trim().toUpperCase() === 'TEAM_TYPE_FY_BUYER_JOB' ? 'TEAM_TYPE_FY_BUYER_JOB' : 'DEFAULT';
}

/** Financial-year start (2 digits) of a date: April 2026 – March 2027 → "26". */
function fyOf(date?: string | null) {
  const d = date && /^\d{4}-\d{2}/.test(date) ? date : new Date().toISOString().slice(0, 10);
  const y = Number(d.slice(0, 4)); const m = Number(d.slice(5, 7));
  return String(m >= 4 ? y : y - 1).slice(2);
}

/** Resolve the fixed part of the SO number (everything but the running number). */
async function soNumberStem(one: One, companyId: number, h: SoNumberInput) {
  const group = await resolveOrderGroup(one, companyId, h);
  if (!group) return null;
  const fmt = await soNumberFormat(one, companyId);
  const initial = ORDER_TYPE_INITIAL[(h.order_type ?? 'EXPORT') as keyof typeof ORDER_TYPE_INITIAL] ?? 'E';

  if (fmt === 'TEAM_TYPE_FY_BUYER_JOB') {
    if (!h.buyer_id) return null;
    const b = await one<{ short_code: string | null; io_prefix: string | null; party_name: string | null }>(
      `SELECT short_code, io_prefix, party_name FROM mst_party WHERE id = ? AND company_id = ?`, [h.buyer_id, companyId]);
    // 3-letter buyer code: the party's short code, else the first 3 letters of its I/O prefix / name
    const code = ((b?.short_code ?? '').replace(/[^a-zA-Z0-9]/g, '')
      || (b?.io_prefix ?? '').replace(/[^a-zA-Z]/g, '')
      || (b?.party_name ?? '').replace(/[^a-zA-Z]/g, '')).slice(0, 3).toUpperCase();
    if (code.length < 3) return null;
    const fy = fyOf(h.so_date);
    return { stem: `${group}${initial}${fy}${code}`, yy: fy, fmt };
  }

  let prefix = '';
  if (h.buyer_id) {
    const b = await one<{ io_prefix: string | null; party_name: string | null }>(
      `SELECT io_prefix, party_name FROM mst_party WHERE id = ? AND company_id = ?`, [h.buyer_id, companyId]);
    prefix = (b?.io_prefix ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
      || (b?.party_name ?? '').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
  }
  if (!prefix) return null;

  const yy = (h.so_date && /^\d{4}/.test(h.so_date) ? h.so_date.slice(2, 4)
    : String(new Date().getFullYear()).slice(2));
  return { stem: `${group}${initial}${yy}${prefix}`, yy, fmt };
}

/** Sequence table / key column of a numbering format. */
const seqOf = (fmt: SoNumberFormat) => (fmt === 'TEAM_TYPE_FY_BUYER_JOB'
  ? { table: 'cfg_so_number_seq_fy', key: 'fy' } : { table: 'cfg_so_number_seq', key: 'yy' });

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
    throw BadRequest('Choose the buyer — its short code / I/O prefix (or name) forms the SO number', [{ field: 'buyer_id', message: 'Select the buyer' }]);
  }

  // Upsert takes the row's exclusive lock straight away (INSERT IGNORE would
  // take a shared lock and deadlock concurrent orders on the FOR UPDATE).
  const seq = seqOf(parts.fmt);
  await txExecute(tx,
    `INSERT INTO ${seq.table} (company_id, ${seq.key}, next_number) VALUES (?,?,1)
     ON DUPLICATE KEY UPDATE next_number = next_number`, [companyId, parts.yy]);
  const row = await txQueryOne<{ next_number: number }>(tx,
    `SELECT next_number FROM ${seq.table} WHERE company_id = ? AND ${seq.key} = ? FOR UPDATE`, [companyId, parts.yy]);
  let n = row?.next_number ?? 1;
  for (;; n++) {
    if (n > 9999) throw Conflict(`SO running number for ${parts.fmt === 'DEFAULT' ? '' : 'FY '}20${parts.yy} has passed 9999`);
    const soNo = `${parts.stem}${String(n).padStart(4, '0')}`;
    const dup = await txQueryOne(tx,
      `SELECT id FROM trx_sales_order WHERE company_id = ? AND so_no = ?`, [companyId, soNo]);
    if (!dup) {
      await txExecute(tx, `UPDATE ${seq.table} SET next_number = ? WHERE company_id = ? AND ${seq.key} = ?`,
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
  const seq = seqOf(parts.fmt);
  const row = await queryOne<{ next_number: number }>(
    `SELECT next_number FROM ${seq.table} WHERE company_id = ? AND ${seq.key} = ?`, [companyId, parts.yy]);
  const soNo = `${parts.stem}${String(row?.next_number ?? 1).padStart(4, '0')}`;
  res.json({ data: { so_no: soNo, stem: parts.stem, format: parts.fmt } });
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

  const [lines, prodOrders, invoices, amendments] = await Promise.all([
    loadLines(id),
    query(`SELECT id, po_prod_no, style_id, order_qty, produced_qty, approval_state
             FROM trx_production_order WHERE so_id = ? ORDER BY id`, [id]),
    query(`SELECT id, invoice_no, invoice_date, total_value FROM trx_commercial_invoice
            WHERE so_id = ? ORDER BY id`, [id]),
    loadAmendments(id),
  ]);
  res.json({ data: { ...so, lines, production_orders: prodOrders, invoices, amendments } });
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
  // A saved line list is rewritten (delete + insert): that would drop the "additional" lines' amendment links and the
  // cancelled quantities, so once an order has posted amendments its quantities change only through amendments.
  if (body.lines) {
    const am = await queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM trx_sales_order_amendment WHERE so_id = ? AND company_id = ? AND status = 'POSTED'`, [id, req.user!.companyId]);
    if (Number(am?.n ?? 0) > 0) {
      throw Conflict('This order has amendments — change its quantities with "Amend order" (add / cancel quantity), not by editing the lines');
    }
  }
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
    // Closing / cancelling through the state change also records the closure for the period reports;
    // re-opening clears it.
    if (approval_state === 'CLOSED' || approval_state === 'CANCELLED') {
      if (!before.closure_type || (before.approval_state !== approval_state)) {
        await txExecute(tx,
          `UPDATE trx_sales_order SET closure_type = ?, closed_date = CURDATE(), close_reason = COALESCE(?, close_reason),
                  closed_by = ?, closed_at = NOW() WHERE id = ?`,
          [approval_state === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED', remarks ?? null, req.user!.id, id]);
      }
    } else if (before.closure_type) {
      await txExecute(tx,
        `UPDATE trx_sales_order SET closure_type = NULL, closed_date = NULL, close_reason = NULL, closed_by = NULL, closed_at = NULL WHERE id = ?`, [id]);
    }
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

// =====================================================================
// AMENDMENTS — quantity revisions of a running order (client call 14-Oct)
// ---------------------------------------------------------------------
// Allowed on APPROVED and ON_HOLD orders only: a DRAFT / PENDING / REJECTED
// order is still editable and is changed through PUT; CLOSED / CANCELLED
// orders are final. ADDITIONAL adds NEW lines (is_additional = 1, the
// amendment's id) — original lines are never touched, so production orders
// and programs that point at them keep their numbers. CANCEL reduces a
// line / size in place, never below what is already cut (good cut pieces of
// that colour × size on the job) or produced on the line's production orders,
// and keeps the reduction in cancelled_qty. Amendments are numbered A1, A2 …
// per order. MRP / BOM requirement read the live line totals, so they follow
// at once; the frozen job requirement snapshot is refreshed on request.
// =====================================================================

const AMENDABLE = ['APPROVED', 'ON_HOLD'];

async function loadAmendments(soId: number) {
  const heads = await query<any>(
    `SELECT a.*, u.full_name AS created_by_name
       FROM trx_sales_order_amendment a
       LEFT JOIN mst_user u ON u.id = a.created_by
      WHERE a.so_id = ? ORDER BY a.amendment_seq`, [soId]);
  if (!heads.length) return [];
  const lines = await query<any>(
    `SELECT al.*, st.style_code, c.color_name, sz.size_code, sz.sort_order
       FROM trx_sales_order_amendment_line al
       LEFT JOIN mst_style st ON st.id = al.style_id
       LEFT JOIN mst_color c ON c.id = al.color_id
       LEFT JOIN mst_size sz ON sz.id = al.size_id
      WHERE al.amendment_id IN (?) ORDER BY al.id`, [heads.map((h) => h.id)]);
  return heads.map((h) => ({ ...h, lines: lines.filter((l) => Number(l.amendment_id) === Number(h.id)) }));
}

/** Order qty of one style × colour × size cell across the whole order (size null = lines without a size breakdown). */
async function cellOrderQty(tx: Tx, soId: number, styleId: number, colorId: number | null, sizeId: number | null) {
  if (sizeId) {
    const r = await txQueryOne<{ q: number }>(tx,
      `SELECT COALESCE(SUM(ss.qty),0) q FROM trx_sales_order_sku ss
         JOIN trx_sales_order_line l ON l.id = ss.so_line_id
         JOIN mst_style_sku k ON k.id = ss.sku_id
        WHERE l.so_id = ? AND l.style_id = ? AND (COALESCE(k.color_id, l.color_id) <=> ?) AND k.size_id = ?`,
      [soId, styleId, colorId, sizeId]);
    return Number(r?.q ?? 0);
  }
  const r = await txQueryOne<{ q: number }>(tx,
    `SELECT COALESCE(SUM(l.order_qty),0) q FROM trx_sales_order_line l
      WHERE l.so_id = ? AND l.style_id = ? AND (l.color_id <=> ?)
        AND NOT EXISTS (SELECT 1 FROM trx_sales_order_sku ss WHERE ss.so_line_id = l.id)`, [soId, styleId, colorId]);
  return Number(r?.q ?? 0);
}

/** Good pieces already cut for a job cell (reversed cut outputs ignored). */
async function cellCutQty(tx: Tx, companyId: number, ioNo: string | null, styleId: number, colorId: number | null, sizeId: number | null) {
  if (!ioNo) return 0;
  const r = await txQueryOne<{ q: number }>(tx,
    `SELECT COALESCE(SUM(good_qty),0) q FROM trx_cut_output
      WHERE company_id = ? AND io_no = ? AND style_id = ? AND (? IS NULL OR color_id <=> ?) AND (? IS NULL OR size_id = ?)
        AND COALESCE(status, '') <> 'REVERSED'`,
    [companyId, ioNo, styleId, colorId, colorId, sizeId, sizeId]);
  return Number(r?.q ?? 0);
}

const amendAddLine = lineSchema.extend({
  unit_price: z.coerce.number().min(0).optional(),
});
const amendmentSchema = z.discriminatedUnion('amendment_type', [
  z.object({
    amendment_type: z.literal('ADDITIONAL'),
    amendment_date: s.date(),
    reason: s.nullableStr(500),
    buyer_ref: s.nullableStr(80),
    lines: z.array(amendAddLine).min(1, 'Enter the additional quantity'),
  }),
  z.object({
    amendment_type: z.literal('CANCEL'),
    amendment_date: s.date(),
    reason: z.string().trim().min(1, 'Give the reason for cancelling the quantity').max(500),
    buyer_ref: s.nullableStr(80),
    lines: z.array(z.object({
      so_line_id: s.idReq(),
      /** mst_style_sku id of the size to reduce — required when the line has a size breakdown. */
      sku_id: s.id(),
      qty: z.coerce.number().int().min(1, 'Cancel qty must be at least 1'),
    })).min(1, 'Enter the quantity to cancel'),
  }),
]);

/** Plan cut of a qty at a size / line excess %. */
const planCutAt = (qty: number, pct: number) => Math.round(qty * (1 + (pct || 0) / 100));

salesOrderRouter.get('/:id/amendments', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const so = await queryOne(`SELECT id FROM trx_sales_order WHERE id = ? AND company_id = ?`, [id, req.user!.companyId]);
  if (!so) throw NotFound('Sales order not found');
  res.json({ data: await loadAmendments(id) });
}));

salesOrderRouter.post('/:id/amendments', requirePermission('SALES_ORDER.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cid = req.user!.companyId;
  const body = amendmentSchema.parse(req.body);

  const out = await transaction(async (tx) => {
    const so = await txQueryOne<any>(tx,
      `SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0 FOR UPDATE`, [id, cid]);
    if (!so) throw NotFound('Sales order not found');
    if (!AMENDABLE.includes(so.approval_state)) {
      throw BadRequest(['CLOSED', 'CANCELLED'].includes(so.approval_state)
        ? `This order is ${String(so.approval_state).toLowerCase()} — it cannot be amended`
        : 'Only an approved (running) order is amended — a draft / pending order is edited directly');
    }
    const last = await txQueryOne<{ n: number }>(tx,
      `SELECT COALESCE(MAX(amendment_seq),0) n FROM trx_sales_order_amendment WHERE so_id = ?`, [id]);
    const seq = Number(last?.n ?? 0) + 1;
    const amNo = `A${seq}`;
    const am = await txExecute(tx,
      `INSERT INTO trx_sales_order_amendment (company_id, so_id, amendment_no, amendment_seq, amendment_date, amendment_type, reason, buyer_ref, status, created_by)
       VALUES (?,?,?,?,?,?,?,?, 'POSTED', ?)`,
      [cid, id, amNo, seq, body.amendment_date ?? new Date().toISOString().slice(0, 10), body.amendment_type,
       body.reason ?? null, body.buyer_ref ?? null, req.user!.id]);
    const amId = Number(am.insertId);
    let total = 0;
    const addAmLine = (r: { so_line_id: number | null; so_sku_id: number | null; style_id: number; color_id: number | null; size_id: number | null; sku_id: number | null; qty: number; plan_cut: number; before: number; after: number }) =>
      txExecute(tx,
        `INSERT INTO trx_sales_order_amendment_line (amendment_id, so_line_id, so_sku_id, style_id, color_id, size_id, sku_id, qty, plan_cut_qty, before_qty, after_qty)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [amId, r.so_line_id, r.so_sku_id, r.style_id, r.color_id, r.size_id, r.sku_id, r.qty, r.plan_cut, r.before, r.after]);

    if (body.amendment_type === 'ADDITIONAL') {
      // Defaults (price, excess %, part, assort colour, ship date) come from the original line of the same style + colour.
      const prepared: z.infer<typeof lineSchema>[] = [];
      for (const l of body.lines) {
        const orig = await txQueryOne<any>(tx,
          `SELECT * FROM trx_sales_order_line WHERE so_id = ? AND style_id = ?
            ORDER BY (color_id <=> ?) DESC, is_additional, id LIMIT 1`, [id, l.style_id, l.color_id ?? null]);
        prepared.push({
          ...l,
          unit_price: l.unit_price ?? Number(orig?.unit_price ?? 0),
          excess_pct: l.excess_pct ?? (orig?.excess_pct != null ? Number(orig.excess_pct) : undefined),
          part_name: l.part_name ?? orig?.part_name ?? null,
          assort_color: l.assort_color ?? orig?.assort_color ?? null,
          ship_date: l.ship_date ?? (orig?.ship_date ? new Date(orig.ship_date).toISOString().slice(0, 10) : null),
          description: l.description ?? `Additional qty ${amNo}${body.reason ? ` — ${body.reason}` : ''}`.slice(0, 255),
          plan_cut_qty: undefined,
        });
      }
      // before-qty of every cell, read before the new lines go in
      const cellKey = (st: number, c: number | null, sz: number | null) => `${st}|${c ?? ''}|${sz ?? ''}`;
      const beforeCells = new Map<string, number>();
      for (const l of prepared) {
        for (const sk of l.skus.filter((x) => x.qty > 0)) {
          const k = await txQueryOne<any>(tx, `SELECT color_id, size_id FROM mst_style_sku WHERE id = ?`, [sk.sku_id]);
          if (!k) continue;
          const key = cellKey(l.style_id, k.color_id ?? l.color_id ?? null, k.size_id);
          if (!beforeCells.has(key)) beforeCells.set(key, await cellOrderQty(tx, id, l.style_id, k.color_id ?? l.color_id ?? null, k.size_id));
        }
        if (!l.skus.some((x) => x.qty > 0)) {
          const key = cellKey(l.style_id, l.color_id ?? null, null);
          if (!beforeCells.has(key)) beforeCells.set(key, await cellOrderQty(tx, id, l.style_id, l.color_id ?? null, null));
        }
      }
      const written = await writeLines(tx, id, prepared, Number(so.excess_pct) || 0, { amendmentId: amId });
      const running = new Map(beforeCells);
      for (const w of written) {
        total += w.qty;
        if (!w.skus.length) {
          const key = cellKey(w.style_id, w.color_id, null);
          const b = running.get(key) ?? 0;
          running.set(key, b + w.qty);
          await addAmLine({ so_line_id: w.so_line_id, so_sku_id: null, style_id: w.style_id, color_id: w.color_id, size_id: null, sku_id: null,
            qty: w.qty, plan_cut: w.plan_cut, before: b, after: b + w.qty });
        }
        for (const sk of w.skus) {
          const k = await txQueryOne<any>(tx, `SELECT color_id, size_id FROM mst_style_sku WHERE id = ?`, [sk.sku_id]);
          const color = k?.color_id ?? w.color_id ?? null;
          const key = cellKey(w.style_id, color, k?.size_id ?? null);
          const b = running.get(key) ?? 0;
          running.set(key, b + sk.qty);
          await addAmLine({ so_line_id: w.so_line_id, so_sku_id: sk.so_sku_id, style_id: w.style_id, color_id: color, size_id: k?.size_id ?? null,
            sku_id: sk.sku_id, qty: sk.qty, plan_cut: sk.plan_cut, before: b, after: b + sk.qty });
        }
      }
    } else {
      for (const c of body.lines) {
        const line = await txQueryOne<any>(tx,
          `SELECT l.*, st.style_code FROM trx_sales_order_line l JOIN mst_style st ON st.id = l.style_id
            WHERE l.id = ? AND l.so_id = ? FOR UPDATE`, [c.so_line_id, id]);
        if (!line) throw BadRequest(`Order line #${c.so_line_id} is not on this order`);
        const linePct = Number(line.excess_pct) || 0;
        const hasSizes = await txQueryOne(tx, `SELECT 1 x FROM trx_sales_order_sku WHERE so_line_id = ? LIMIT 1`, [line.id]);
        let colorId: number | null = line.color_id ?? null;
        let sizeId: number | null = null;
        let soSkuId: number | null = null;
        let planDrop = 0;
        let label = line.style_code;

        if (hasSizes) {
          if (!c.sku_id) throw BadRequest(`${line.style_code}: pick the size to cancel — this line has a size breakdown`);
          const sk = await txQueryOne<any>(tx,
            `SELECT ss.*, k.color_id, k.size_id, sz.size_code, col.color_name FROM trx_sales_order_sku ss
               JOIN mst_style_sku k ON k.id = ss.sku_id
               JOIN mst_size sz ON sz.id = k.size_id
               LEFT JOIN mst_color col ON col.id = k.color_id
              WHERE ss.so_line_id = ? AND ss.sku_id = ? FOR UPDATE`, [line.id, c.sku_id]);
          if (!sk) throw BadRequest(`${line.style_code}: size #${c.sku_id} is not on this line`);
          label = `${line.style_code} ${sk.color_name ?? ''} ${sk.size_code}`.replace(/\s+/g, ' ');
          if (c.qty > Number(sk.qty)) throw BadRequest(`${label}: cannot cancel ${c.qty} — only ${sk.qty} on the order`);
          const newQty = Number(sk.qty) - c.qty;
          const pct = sk.excess_pct != null ? Number(sk.excess_pct) : linePct;
          const newPlan = planCutAt(newQty, pct);
          planDrop = Number(sk.plan_cut_qty ?? planCutAt(Number(sk.qty), pct)) - newPlan;
          await txExecute(tx,
            `UPDATE trx_sales_order_sku SET qty = ?, plan_cut_qty = ?, cancelled_qty = cancelled_qty + ? WHERE id = ?`,
            [newQty, newPlan, c.qty, sk.id]);
          colorId = sk.color_id ?? colorId; sizeId = sk.size_id; soSkuId = Number(sk.id);
          // line total = its sizes; plan cut = sum of size plan cuts
          const agg = await txQueryOne<any>(tx,
            `SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(COALESCE(plan_cut_qty, qty)),0) p FROM trx_sales_order_sku WHERE so_line_id = ?`, [line.id]);
          await txExecute(tx,
            `UPDATE trx_sales_order_line SET order_qty = ?, plan_cut_qty = ?, amount = ROUND(? * unit_price, 4), cancelled_qty = cancelled_qty + ? WHERE id = ?`,
            [Number(agg.q), Number(agg.p), Number(agg.q), c.qty, line.id]);
        } else {
          if (c.qty > Number(line.order_qty)) throw BadRequest(`${label}: cannot cancel ${c.qty} — only ${line.order_qty} on the line`);
          const newQty = Number(line.order_qty) - c.qty;
          const newPlan = planCutAt(newQty, linePct);
          planDrop = Number(line.plan_cut_qty || line.order_qty) - newPlan;
          await txExecute(tx,
            `UPDATE trx_sales_order_line SET order_qty = ?, plan_cut_qty = ?, amount = ROUND(? * unit_price, 4), cancelled_qty = cancelled_qty + ? WHERE id = ?`,
            [newQty, newPlan, newQty, c.qty, line.id]);
        }

        // Floors: produced on the line's production orders, and good pieces already cut for the cell.
        const lineNow = await txQueryOne<any>(tx, `SELECT order_qty FROM trx_sales_order_line WHERE id = ?`, [line.id]);
        const produced = await txQueryOne<{ q: number }>(tx,
          `SELECT COALESCE(SUM(produced_qty),0) q FROM trx_production_order
            WHERE so_line_id = ? AND COALESCE(approval_state,'') <> 'CANCELLED'`, [line.id]);
        if (Number(lineNow.order_qty) < Number(produced?.q ?? 0)) {
          throw BadRequest(`${label}: ${produced?.q} pcs are already produced on this line — it cannot go below that`);
        }
        const after = await cellOrderQty(tx, id, line.style_id, colorId, sizeId);
        const cut = await cellCutQty(tx, cid, so.io_no, line.style_id, colorId, sizeId);
        if (after < cut) {
          throw BadRequest(`${label}: ${cut} pcs are already cut — the order can be reduced to ${cut} at most (asked ${after})`);
        }
        total += c.qty;
        await addAmLine({ so_line_id: line.id, so_sku_id: soSkuId, style_id: line.style_id, color_id: colorId, size_id: sizeId,
          sku_id: c.sku_id ?? null, qty: c.qty, plan_cut: Math.max(0, planDrop), before: after + c.qty, after });
      }
    }

    await txExecute(tx, `UPDATE trx_sales_order_amendment SET total_qty = ? WHERE id = ?`, [total, amId]);
    await recalcHeader(tx, id);
    await txExecute(tx, `UPDATE trx_sales_order SET updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    return { id: amId, amendment_no: amNo, amendment_type: body.amendment_type, total_qty: total };
  });

  await audit(req, 'trx_sales_order_amendment', out.id, 'INSERT', undefined, { so_id: id, ...out, lines: body.lines });
  res.status(201).json({
    data: out,
    message: `${out.amendment_no}: ${out.total_qty} pcs ${out.amendment_type === 'ADDITIONAL' ? 'added' : 'cancelled'}`,
  });
}));

/**
 * Void an amendment (status CANCELLED). ADDITIONAL: its lines are removed — only while nothing downstream
 * (production orders, cutting / knitting programs, packing …) points at them. CANCEL: the quantity is put back.
 */
salesOrderRouter.post('/:id/amendments/:aid/void', requirePermission('SALES_ORDER.APPROVE'), ah(async (req, res) => {
  const id = Number(req.params.id); const aid = Number(req.params.aid);
  const cid = req.user!.companyId;
  const reason = z.object({ reason: z.string().trim().min(1, 'Give the reason').max(300) }).parse(req.body).reason;
  await transaction(async (tx) => {
    const so = await txQueryOne<any>(tx, `SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!so) throw NotFound('Sales order not found');
    if (!AMENDABLE.includes(so.approval_state)) throw BadRequest(`This order is ${String(so.approval_state).toLowerCase()}`);
    const am = await txQueryOne<any>(tx, `SELECT * FROM trx_sales_order_amendment WHERE id = ? AND so_id = ? FOR UPDATE`, [aid, id]);
    if (!am) throw NotFound('Amendment not found');
    if (am.status !== 'POSTED') throw BadRequest(`${am.amendment_no} is already cancelled`);
    const later = await txQueryOne(tx,
      `SELECT amendment_no FROM trx_sales_order_amendment WHERE so_id = ? AND amendment_seq > ? AND status = 'POSTED' LIMIT 1`, [id, am.amendment_seq]);
    if (later) throw BadRequest(`Cancel the later amendment ${(later as any).amendment_no} first`);
    const lines = await txQuery<any>(tx, `SELECT * FROM trx_sales_order_amendment_line WHERE amendment_id = ?`, [aid]);

    if (am.amendment_type === 'ADDITIONAL') {
      const lineIds = [...new Set(lines.map((l) => Number(l.so_line_id)).filter(Boolean))];
      if (lineIds.length) {
        for (const t of ['trx_production_order', 'trx_cutting_plan', 'trx_knitting_order', 'trx_knitting_program', 'trx_collar_program', 'trx_packing', 'trx_yarn_process']) {
          const used = await txQuery<any>(tx, `SELECT 1 x FROM ${t} WHERE so_line_id IN (?) LIMIT 1`, [lineIds]).catch(() => []);
          if (used.length) throw BadRequest(`${am.amendment_no}'s lines are already used downstream (${t.replace('trx_', '').replace(/_/g, ' ')}) — cancel the quantity with a CANCEL amendment instead`);
        }
        await txQuery(tx, `DELETE FROM trx_sales_order_sku WHERE so_line_id IN (?)`, [lineIds]);
        await txQuery(tx, `DELETE FROM trx_sales_order_line WHERE id IN (?) AND amendment_id = ?`, [lineIds, aid]);
      }
    } else {
      for (const l of lines) {
        if (l.so_sku_id) {
          const sk = await txQueryOne<any>(tx, `SELECT * FROM trx_sales_order_sku WHERE id = ? FOR UPDATE`, [l.so_sku_id]);
          if (!sk) continue;
          const ln = await txQueryOne<any>(tx, `SELECT excess_pct FROM trx_sales_order_line WHERE id = ?`, [sk.so_line_id]);
          const pct = sk.excess_pct != null ? Number(sk.excess_pct) : Number(ln?.excess_pct) || 0;
          const q = Number(sk.qty) + Number(l.qty);
          await txExecute(tx, `UPDATE trx_sales_order_sku SET qty = ?, plan_cut_qty = ?, cancelled_qty = GREATEST(cancelled_qty - ?, 0) WHERE id = ?`,
            [q, planCutAt(q, pct), l.qty, sk.id]);
          const agg = await txQueryOne<any>(tx,
            `SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(COALESCE(plan_cut_qty, qty)),0) p FROM trx_sales_order_sku WHERE so_line_id = ?`, [sk.so_line_id]);
          await txExecute(tx,
            `UPDATE trx_sales_order_line SET order_qty = ?, plan_cut_qty = ?, amount = ROUND(? * unit_price, 4), cancelled_qty = GREATEST(cancelled_qty - ?, 0) WHERE id = ?`,
            [Number(agg.q), Number(agg.p), Number(agg.q), l.qty, sk.so_line_id]);
        } else if (l.so_line_id) {
          const ln = await txQueryOne<any>(tx, `SELECT * FROM trx_sales_order_line WHERE id = ? FOR UPDATE`, [l.so_line_id]);
          if (!ln) continue;
          const q = Number(ln.order_qty) + Number(l.qty);
          await txExecute(tx,
            `UPDATE trx_sales_order_line SET order_qty = ?, plan_cut_qty = ?, amount = ROUND(? * unit_price, 4), cancelled_qty = GREATEST(cancelled_qty - ?, 0) WHERE id = ?`,
            [q, planCutAt(q, Number(ln.excess_pct) || 0), q, l.qty, ln.id]);
        }
      }
    }
    await txExecute(tx,
      `UPDATE trx_sales_order_amendment SET status = 'CANCELLED', void_reason = ?, voided_by = ?, voided_at = NOW() WHERE id = ?`,
      [reason, req.user!.id, aid]);
    await recalcHeader(tx, id);
  });
  await audit(req, 'trx_sales_order_amendment', aid, 'UPDATE', undefined, { status: 'CANCELLED', reason });
  res.json({ data: { id: aid, status: 'CANCELLED' } });
}));

/**
 * GET /:id/amendments/:aid/requirement — fabric / yarn / trims needed for (ADDITIONAL) or released by (CANCEL)
 * just this amendment's colour × size cells: the job's BOM per style (same pick as MRP / for-job), each BOM line
 * multiplied by the plan-cut pieces of the cells it covers, + wastage. Fixed-qty and "additional qty" BOM
 * allowances are per job, not per piece, so they are not repeated for an amendment.
 */
salesOrderRouter.get('/:id/amendments/:aid/requirement', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id); const aid = Number(req.params.aid);
  const cid = req.user!.companyId;
  const am = await queryOne<any>(
    `SELECT a.* FROM trx_sales_order_amendment a JOIN trx_sales_order so ON so.id = a.so_id
      WHERE a.id = ? AND a.so_id = ? AND so.company_id = ?`, [aid, id, cid]);
  if (!am) throw NotFound('Amendment not found');
  const amLines = await query<any>(
    `SELECT al.*, st.style_code, st.style_name FROM trx_sales_order_amendment_line al
       JOIN mst_style st ON st.id = al.style_id WHERE al.amendment_id = ?`, [aid]);

  const byStyle = new Map<number, { style_id: number; style_code: string; style_name: string; cells: OrderCell[] }>();
  for (const l of amLines) {
    const g = byStyle.get(Number(l.style_id)) ?? { style_id: Number(l.style_id), style_code: l.style_code, style_name: l.style_name, cells: [] as OrderCell[] };
    g.cells.push({ color_id: l.color_id == null ? null : Number(l.color_id), size_id: l.size_id == null ? null : Number(l.size_id),
      qty: Number(l.qty), plan_cut: Number(l.plan_cut_qty) || Number(l.qty) });
    byStyle.set(g.style_id, g);
  }

  const items: any[] = [];
  const warnings: string[] = [];
  const styles: any[] = [];
  for (const g of byStyle.values()) {
    let bom: any = null;
    try { bom = await jobBomRequirement(cid, { so_id: id, style_id: g.style_id }); }
    catch (e: any) { warnings.push(`${g.style_code}: ${e?.message ?? 'no BOM'}`); }
    styles.push({ style_id: g.style_id, style_code: g.style_code, style_name: g.style_name,
      qty: g.cells.reduce((a, c) => a + c.qty, 0), plan_cut: cellsPlanCut(g.cells), bom_no: bom?.bom?.bom_no ?? null });
    if (!bom) continue;
    for (const l of bom.lines as any[]) {
      const basis = String(l.consumption_basis || 'PER_PIECE');
      if (basis === 'FIXED_QTY') continue;
      const cells = cellsFor(l, g.cells);
      const pcs = cellsPlanCut(cells);
      if (pcs <= 0) continue;
      const r = lineRequirement({ ...l, additional_qty: 0 }, pcs);
      let reqQty = Number(r.required.toFixed(3));
      if (['PCS', 'NOS', 'PC', 'SET'].includes(String(l.uom_code || '').toUpperCase())) reqQty = Math.ceil(reqQty);
      items.push({
        style_code: g.style_code, bom_no: l.bom_no, bom_line_id: l.bom_line_id,
        material_type: l.material_type, material_name: l.material_name,
        yarn_id: l.yarn_id ?? null, fabric_id: l.fabric_id ?? null, trim_id: l.trim_id ?? null,
        color_name: l.color_name ?? null, size_code: l.size_code ?? null,
        purchase_color_name: l.purchase_color_name ?? null,
        consumption: Number(l.consumption) || 0, consumption_basis: basis, wastage_pct: Number(l.wastage_pct) || 0,
        uom_code: l.uom_code ?? null, pieces: pcs, required_qty: reqQty,
      });
    }
  }
  const sum = (t: string) => items.filter((i) => i.material_type === t);
  res.json({
    data: {
      amendment: am,
      direction: am.amendment_type === 'ADDITIONAL' ? 'NEEDED' : 'RELEASED',
      styles, warnings, lines: items,
      fabrics: sum('FABRIC'), yarns: sum('YARN'), trims: items.filter((i) => !['FABRIC', 'YARN'].includes(i.material_type)),
      reason: items.length ? null : (warnings[0] ?? 'The BOM has no per-piece lines for these colours / sizes'),
    },
  });
}));

// =====================================================================
// ORDER CLOSURE — cancel the whole order, short close or complete it.
// Status + date + reason are kept on the order so reports can list orders
// cancelled / closed in a period (GET /sales-orders?closure_type=&closedFrom=&closedTo=).
// =====================================================================
const closeSchema = z.object({
  action: z.enum(['CANCEL', 'SHORT_CLOSE', 'COMPLETE']),
  closed_date: s.date(),
  reason: z.string().trim().max(300).nullish(),
});

salesOrderRouter.post('/:id/close', requirePermission('SALES_ORDER.APPROVE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const body = closeSchema.parse(req.body);
  if (body.action !== 'COMPLETE' && !body.reason) {
    throw BadRequest(`Give the reason for ${body.action === 'CANCEL' ? 'cancelling' : 'short closing'} the order`, [{ field: 'reason', message: 'Reason is required' }]);
  }
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0`, [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');
  if (['CLOSED', 'CANCELLED'].includes(before.approval_state)) throw BadRequest(`This order is already ${String(before.approval_state).toLowerCase()}`);
  if (body.action !== 'CANCEL' && !['APPROVED', 'ON_HOLD'].includes(before.approval_state)) {
    throw BadRequest('Only an approved order is short closed / completed — cancel a draft instead');
  }
  const state = body.action === 'CANCEL' ? 'CANCELLED' : 'CLOSED';
  const closure = body.action === 'CANCEL' ? 'CANCELLED' : body.action === 'SHORT_CLOSE' ? 'SHORT_CLOSED' : 'COMPLETED';
  const after = await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_sales_order SET approval_state = ?, closure_type = ?, closed_date = ?, close_reason = ?, closed_by = ?, closed_at = NOW(), updated_by = ?
        WHERE id = ?`,
      [state, closure, body.closed_date ?? new Date().toISOString().slice(0, 10), body.reason ?? null, req.user!.id, req.user!.id, id]);
    await txExecute(tx,
      `INSERT INTO trx_status_history (domain, record_id, to_status_id, remarks, changed_by)
       SELECT 'SALES_ORDER', ?, id, ?, ? FROM cfg_status WHERE domain = 'SALES_ORDER' AND code = ? LIMIT 1`,
      [id, `${closure.replace('_', ' ')}${body.reason ? `: ${body.reason}` : ''}`, req.user!.id, state]);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [id]);
  });
  await audit(req, 'trx_sales_order', id, 'UPDATE', before, after);
  res.json({ data: after });
}));
