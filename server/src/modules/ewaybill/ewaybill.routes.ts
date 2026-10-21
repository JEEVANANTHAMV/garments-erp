import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import {
  SUB_SUPPLY_TYPES, DOCUMENT_TYPES, CANCEL_REASONS, VEHICLE_REASONS, EXTEND_REASONS, GST_STATES,
  stateName, computeValues, assertReady, validityUpto, cleanVehicle, VEHICLE_RE, type EwbItemIn,
} from './ewbRules.js';
import { providerOf, type EwbProvider } from './providers.js';
import { prefill, sourceDocs, SOURCE_TYPES, SOURCE_LABEL, SOURCE_EWB_COLUMN, type SourceType } from './prefill.js';

/**
 * E-way bills (GST) — client 21-Oct-2026, provider Masters India.
 * Draft (from a dispatch / process DC / purchase return / gate outward / stock delivery, editable) → Generate
 * (portal through the provider, or MANUAL: EWB no recorded from the portal) → Update vehicle (Part B) / Extend /
 * Cancel (within 24 h). Every action is logged with what was sent and what came back.
 */
export const ewayBillRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
async function setting(cid: number, key: string, dflt: string) {
  const r = await queryOne<any>(`SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`, [cid, key]);
  return r?.setting_value ?? dflt;
}
const providerFor = async (cid: number): Promise<EwbProvider> => providerOf(String(await setting(cid, 'EWB_PROVIDER', 'MANUAL')).toUpperCase());

/** Status shown on screen: a generated EWB past its validity is EXPIRED; within 8 h of the end it can be extended. */
function viewStatus(e: any) {
  if (e.status !== 'GENERATED') return e.status;
  if (e.valid_upto && new Date(e.valid_upto).getTime() < Date.now()) return 'EXPIRED';
  return e.valid_upto ? 'ACTIVE' : 'PART_A';
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const itemSchema = z.object({
  product_name: z.string().trim().min(1, 'Product name is required').max(100),
  description: z.string().trim().max(100).nullish(),
  hsn_code: z.string().trim().max(8).default(''),
  quantity: z.coerce.number().min(0),
  unit: z.string().trim().max(8).default('PCS'),
  taxable_amount: z.coerce.number().min(0),
  cgst_rate: z.coerce.number().min(0).max(28).default(0), sgst_rate: z.coerce.number().min(0).max(28).default(0),
  igst_rate: z.coerce.number().min(0).max(28).default(0), cess_rate: z.coerce.number().min(0).max(300).default(0),
});
const ewbSchema = z.object({
  source_type: z.enum([...SOURCE_TYPES, 'MANUAL'] as [string, ...string[]]).default('MANUAL'),
  source_id: z.coerce.number().int().positive().nullish(),
  source_no: z.string().trim().max(60).nullish(),
  supply_type: z.enum(['OUTWARD', 'INWARD']).default('OUTWARD'),
  sub_supply_type: z.enum(SUB_SUPPLY_TYPES).default('Supply'),
  sub_supply_desc: z.string().trim().max(100).nullish(),
  document_type: z.enum(DOCUMENT_TYPES).default('Tax Invoice'),
  document_number: z.string().trim().min(1, 'Document number is required').max(16),
  document_date: dateStr,
  transaction_type: z.coerce.number().int().min(1).max(4).default(1),
  from_gstin: z.string().trim().toUpperCase().max(15), from_name: z.string().trim().min(1).max(100),
  from_address1: z.string().trim().max(120).nullish(), from_address2: z.string().trim().max(120).nullish(), from_place: z.string().trim().max(50).nullish(),
  from_pincode: z.string().trim().max(6).nullish(), from_state: z.string().trim().max(50).nullish(), dispatch_state: z.string().trim().max(50).nullish(),
  to_party_id: z.coerce.number().int().positive().nullish(),
  to_gstin: z.string().trim().toUpperCase().max(15).default('URP'), to_name: z.string().trim().min(1, 'Consignee name is required').max(100),
  to_address1: z.string().trim().max(120).nullish(), to_address2: z.string().trim().max(120).nullish(), to_place: z.string().trim().max(50).nullish(),
  to_pincode: z.string().trim().max(6).nullish(), to_state: z.string().trim().max(50).nullish(), ship_state: z.string().trim().max(50).nullish(),
  other_value: z.coerce.number().default(0),
  transporter_party_id: z.coerce.number().int().positive().nullish(),
  transporter_id: z.string().trim().toUpperCase().max(15).nullish(), transporter_name: z.string().trim().max(100).nullish(),
  transport_mode: z.enum(['Road', 'Rail', 'Air', 'Ship']).default('Road'),
  distance_km: z.coerce.number().int().min(0).max(4000).default(0),
  vehicle_no: z.string().trim().max(20).nullish(), vehicle_type: z.enum(['Regular', 'ODC']).default('Regular'),
  transport_doc_no: z.string().trim().max(15).nullish(), transport_doc_date: dateStr.nullish(),
  remarks: z.string().trim().max(300).nullish(),
  items: z.array(itemSchema).min(1, 'Add at least one item').max(250),
});
type EwbBody = z.infer<typeof ewbSchema>;

/** Normalise states, vehicle, rates (inter-state → IGST, intra-state → CGST = SGST) and compute the values. */
function normalise(b: EwbBody) {
  const from_state = stateName(b.from_state) || stateName(b.from_gstin);
  const to_state = b.to_state === 'OTHER COUNTRY' ? 'OTHER COUNTRY' : stateName(b.to_state) || stateName(b.to_gstin);
  const inter = !from_state || !to_state || from_state !== to_state;
  const items: EwbItemIn[] = b.items.map((it) => {
    const rate = n(it.igst_rate) || n(it.cgst_rate) + n(it.sgst_rate);
    return { ...it, description: it.description ?? null, hsn_code: (it.hsn_code ?? '').replace(/\D/g, ''),
      cgst_rate: inter ? 0 : rate / 2, sgst_rate: inter ? 0 : rate / 2, igst_rate: inter ? rate : 0, cess_rate: n(it.cess_rate) };
  });
  const vals = computeValues(items, inter, n(b.other_value));
  return {
    head: { ...b, from_state, to_state, dispatch_state: stateName(b.dispatch_state) || from_state, ship_state: b.ship_state ? stateName(b.ship_state) || null : to_state,
      vehicle_no: b.vehicle_no ? cleanVehicle(b.vehicle_no) : null, to_gstin: b.to_gstin || 'URP', ...vals },
    items, inter,
  };
}

const HEAD_COLS = ['source_type', 'source_id', 'source_no', 'supply_type', 'sub_supply_type', 'sub_supply_desc', 'document_type', 'document_number', 'document_date',
  'transaction_type', 'from_gstin', 'from_name', 'from_address1', 'from_address2', 'from_place', 'from_pincode', 'from_state', 'dispatch_state',
  'to_party_id', 'to_gstin', 'to_name', 'to_address1', 'to_address2', 'to_place', 'to_pincode', 'to_state', 'ship_state',
  'taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'other_value', 'total_invoice_value',
  'transporter_party_id', 'transporter_id', 'transporter_name', 'transport_mode', 'distance_km', 'vehicle_no', 'vehicle_type', 'transport_doc_no', 'transport_doc_date', 'remarks'] as const;

async function writeItems(tx: any, id: number, items: EwbItemIn[]) {
  await txExecute(tx, `DELETE FROM trx_eway_bill_item WHERE ewb_id = ?`, [id]);
  let i = 0;
  for (const it of items) {
    await txExecute(tx, `INSERT INTO trx_eway_bill_item (ewb_id, sort_order, product_name, description, hsn_code, quantity, unit, taxable_amount, cgst_rate, sgst_rate, igst_rate, cess_rate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, i++, it.product_name, it.description ?? null, it.hsn_code, it.quantity, it.unit, it.taxable_amount, it.cgst_rate, it.sgst_rate, it.igst_rate, it.cess_rate]);
  }
}
async function logEvent(tx: any, ewbId: number, action: string, provider: string, ok: boolean, message: string | null, request: unknown, response: unknown, userId: number) {
  await txExecute(tx, `INSERT INTO trx_eway_bill_event (ewb_id, action, provider, ok, message, request, response, user_id) VALUES (?,?,?,?,?,?,?,?)`,
    [ewbId, action, provider, ok ? 1 : 0, message?.slice(0, 500) ?? null, request == null ? null : JSON.stringify(request), response == null ? null : JSON.stringify(response), userId]);
}
/** A failed portal call is still logged (outside the rolled-back transaction) so the user sees what the portal said. */
async function logFailure(ewbId: number, action: string, provider: string, e: any, userId: number) {
  await transaction(async (tx) => {
    await logEvent(tx, ewbId, action, provider, false, e?.message ?? String(e), null, e?.details ?? null, userId);
    await txExecute(tx, `UPDATE trx_eway_bill SET last_error = ? WHERE id = ?`, [String(e?.message ?? e).slice(0, 500), ewbId]);
  }).catch(() => {});
}

async function loadEwb(cid: number, id: number) {
  const e = await queryOne<any>(
    `SELECT e.*, u.full_name created_by_name, cu.full_name cancelled_by_name FROM trx_eway_bill e
       LEFT JOIN mst_user u ON u.id = e.created_by LEFT JOIN mst_user cu ON cu.id = e.cancelled_by
      WHERE e.id = ? AND e.company_id = ?`, [id, cid]);
  if (!e) throw NotFound('E-way bill not found');
  e.items = await query<any>(`SELECT * FROM trx_eway_bill_item WHERE ewb_id = ? ORDER BY sort_order, id`, [id]);
  e.events = await query<any>(`SELECT ev.id, ev.action, ev.provider, ev.ok, ev.message, ev.created_at, u.full_name user_name FROM trx_eway_bill_event ev
    LEFT JOIN mst_user u ON u.id = ev.user_id WHERE ev.ewb_id = ? ORDER BY ev.id DESC`, [id]);
  e.view_status = viewStatus(e);
  e.source_label = SOURCE_LABEL[e.source_type] ?? e.source_type;
  const gen = e.ewb_date ? new Date(e.ewb_date).getTime() : 0;
  const vu = e.valid_upto ? new Date(e.valid_upto).getTime() : 0;
  e.can_cancel = e.status === 'GENERATED' && gen > 0 && Date.now() - gen <= 24 * 3600 * 1000;
  e.can_extend = e.status === 'GENERATED' && vu > 0 && Math.abs(Date.now() - vu) <= 8 * 3600 * 1000;
  e.can_part_b = e.status === 'GENERATED' && (!vu || vu > Date.now());
  return e;
}
const lockEwb = async (tx: any, cid: number, id: number) => {
  const e = await txQueryOne<any>(tx, `SELECT * FROM trx_eway_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
  if (!e) throw NotFound('E-way bill not found');
  return e;
};
const ewbId = (raw: unknown) => { const id = Number(raw); if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid e-way bill id'); return id; };

// ─────────────────────────────────────────────────────────── reference / register

ewayBillRouter.get('/eway-bills/meta', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const p = await providerFor(cid);
  res.json({ data: {
    provider: p.code, provider_label: p.label, online: p.online, threshold: n(await setting(cid, 'EWB_THRESHOLD', '50000')),
    configured: p.code !== 'MASTERS_INDIA' || !!(process.env.MASTERS_INDIA_USERNAME && process.env.MASTERS_INDIA_PASSWORD),
    sub_supply_types: SUB_SUPPLY_TYPES, document_types: DOCUMENT_TYPES, cancel_reasons: CANCEL_REASONS, vehicle_reasons: VEHICLE_REASONS,
    extend_reasons: EXTEND_REASONS, states: Object.values(GST_STATES), source_types: SOURCE_TYPES.map((t) => ({ value: t, label: SOURCE_LABEL[t] })),
  } });
}));

ewayBillRouter.get('/eway-bills', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const f = z.object({ status: z.string().optional(), source_type: z.string().optional(), q: z.string().trim().max(60).optional(),
    from: dateStr.optional(), to: dateStr.optional() }).parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '' && v != null)));
  const rows = await query<any>(
    `SELECT e.id, e.doc_no, e.source_type, e.source_id, e.source_no, e.status, e.ewb_no, e.ewb_date, e.valid_upto, e.document_type, e.document_number, e.document_date,
            e.to_name, e.to_gstin, e.to_place, e.vehicle_no, e.total_invoice_value, e.provider, e.last_error, e.created_at
       FROM trx_eway_bill e
      WHERE e.company_id = ? ${f.source_type ? 'AND e.source_type = ?' : ''} ${f.q ? 'AND (e.doc_no LIKE ? OR e.ewb_no LIKE ? OR e.document_number LIKE ? OR e.to_name LIKE ? OR e.source_no LIKE ? OR e.vehicle_no LIKE ?)' : ''}
        ${f.from ? 'AND e.document_date >= ?' : ''} ${f.to ? 'AND e.document_date <= ?' : ''}
      ORDER BY e.id DESC LIMIT 1000`,
    [cid, ...(f.source_type ? [f.source_type] : []), ...(f.q ? Array(6).fill(`%${f.q}%`) : []), ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]);
  const out = rows.map((r) => ({ ...r, view_status: viewStatus(r), source_label: SOURCE_LABEL[r.source_type] ?? r.source_type,
    expiring_soon: r.status === 'GENERATED' && r.valid_upto && new Date(r.valid_upto).getTime() > Date.now() && new Date(r.valid_upto).getTime() - Date.now() < 12 * 3600 * 1000 }));
  res.json({ data: f.status ? out.filter((r) => r.view_status === f.status) : out });
}));

/** Documents of a type to make an e-way bill from (register picker). */
ewayBillRouter.get('/eway-bills/sources', requirePermission('EWAY.CREATE'), ah(async (req, res) => {
  const type = String(req.query.type ?? '') as SourceType;
  if (!SOURCE_TYPES.includes(type)) throw BadRequest('Pick the kind of document');
  res.json({ data: await sourceDocs(req.user!.companyId, type, String(req.query.q ?? '').slice(0, 60)) });
}));

/** The e-way bill (not cancelled) of a document — the document screens show it or offer "Generate". */
ewayBillRouter.get('/eway-bills/by-source', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  const type = String(req.query.type ?? ''); const id = Number(req.query.id);
  const r = await queryOne<any>(`SELECT id, doc_no, status, ewb_no, valid_upto FROM trx_eway_bill WHERE company_id = ? AND source_type = ? AND source_id = ? AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1`,
    [req.user!.companyId, type, id]);
  res.json({ data: r ? { ...r, view_status: viewStatus(r) } : null });
}));

/** Draft values from the document (not saved). */
ewayBillRouter.get('/eway-bills/prefill', requirePermission('EWAY.CREATE'), ah(async (req, res) => {
  const type = String(req.query.type ?? '') as SourceType; const id = Number(req.query.id);
  if (!SOURCE_TYPES.includes(type) || !(id > 0)) throw BadRequest('Pick the document to make the e-way bill from');
  const cid = req.user!.companyId;
  const existing = await queryOne<any>(`SELECT id, doc_no, ewb_no, status FROM trx_eway_bill WHERE company_id = ? AND source_type = ? AND source_id = ? AND status <> 'CANCELLED' LIMIT 1`, [cid, type, id]);
  const p = await prefill(cid, type, id);
  res.json({ data: { ...p, existing: existing ?? null, threshold: n(await setting(cid, 'EWB_THRESHOLD', '50000')) } });
}));

ewayBillRouter.get('/eway-bills/:id', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  res.json({ data: await loadEwb(req.user!.companyId, ewbId(req.params.id)) });
}));

// ─────────────────────────────────────────────────────────── draft

ewayBillRouter.post('/eway-bills', requirePermission('EWAY.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { head, items } = normalise(ewbSchema.parse(req.body));
  const id = await transaction(async (tx) => {
    if (head.source_type !== 'MANUAL' && head.source_id) {
      const dup = await txQueryOne<any>(tx, `SELECT doc_no, ewb_no FROM trx_eway_bill WHERE company_id = ? AND source_type = ? AND source_id = ? AND status <> 'CANCELLED' LIMIT 1 FOR UPDATE`,
        [cid, head.source_type, head.source_id]);
      if (dup) throw BadRequest(`This document already has e-way bill ${dup.ewb_no ?? dup.doc_no} — cancel it before making another`);
    }
    const docNo = await nextDocNumber(tx, cid, 'EWAY_BILL_DOC');
    const r = await txExecute(tx, `INSERT INTO trx_eway_bill (company_id, doc_no, ${HEAD_COLS.join(', ')}, created_by) VALUES (?,?,${HEAD_COLS.map(() => '?').join(',')},?)`,
      [cid, docNo, ...HEAD_COLS.map((c) => (head as any)[c] ?? null), req.user!.id]);
    await writeItems(tx, r.insertId, items);
    await audit(req, 'trx_eway_bill', r.insertId, 'INSERT', undefined, { doc_no: docNo, source: `${head.source_type} ${head.source_no ?? ''}`, value: head.total_invoice_value }, tx);
    return Number(r.insertId);
  });
  res.status(201).json({ data: await loadEwb(cid, id) });
}));

ewayBillRouter.put('/eway-bills/:id', requirePermission('EWAY.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const { head, items } = normalise(ewbSchema.parse(req.body));
  await transaction(async (tx) => {
    const e = await lockEwb(tx, cid, id);
    if (e.status !== 'DRAFT') throw BadRequest(`E-way bill ${e.ewb_no ?? e.doc_no} is ${e.status} — a generated e-way bill is not edited (update the vehicle, extend or cancel it)`);
    const keep = { ...head, source_type: e.source_type, source_id: e.source_id, source_no: e.source_no };
    await txExecute(tx, `UPDATE trx_eway_bill SET ${HEAD_COLS.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [...HEAD_COLS.map((c) => (keep as any)[c] ?? null), req.user!.id, id]);
    await writeItems(tx, id, items);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

ewayBillRouter.delete('/eway-bills/:id', requirePermission('EWAY.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  await transaction(async (tx) => {
    const e = await lockEwb(tx, cid, id);
    if (e.status !== 'DRAFT') throw BadRequest('Only a draft e-way bill is deleted — a generated one is cancelled');
    await txExecute(tx, `DELETE FROM trx_eway_bill_item WHERE ewb_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_eway_bill_event WHERE ewb_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_eway_bill WHERE id = ?`, [id]);
    await audit(req, 'trx_eway_bill', id, 'DELETE', { doc_no: e.doc_no }, undefined, tx);
  });
  res.json({ data: { id, deleted: true } });
}));

// ─────────────────────────────────────────────────────────── portal actions

const toDate = (v: string | null | undefined) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v) : null);

/**
 * Generate. Online provider: sent to the portal. MANUAL: the e-way bill was generated on the GST portal — record its
 * 12-digit number, date and validity (validity worked out from the distance when not given).
 */
ewayBillRouter.post('/eway-bills/:id/generate', requirePermission('EWAY.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const b = z.object({ ewb_no: z.string().trim().optional(), ewb_date: z.string().trim().optional(), valid_upto: z.string().trim().optional() }).parse(req.body ?? {});
  const provider = await providerFor(cid);
  const e0 = await loadEwb(cid, id);
  if (e0.status !== 'DRAFT') throw BadRequest(`E-way bill is already ${e0.status}${e0.ewb_no ? ` (${e0.ewb_no})` : ''}`);
  assertReady(e0, e0.items.map((i: any) => ({ ...i, quantity: n(i.quantity), taxable_amount: n(i.taxable_amount) })), { needPartB: false });
  let result: { ewb_no?: string; ewb_date?: Date | null; valid_upto?: Date | null; url?: string | null; raw?: unknown; request?: unknown };
  if (provider.online) {
    try { result = await provider.generate(e0, e0.items); } catch (err) { await logFailure(id, 'GENERATE', provider.code, err, req.user!.id); throw err; }
  } else {
    if (!/^\d{12}$/.test(b.ewb_no ?? '')) throw BadRequest('Enter the 12-digit e-way bill number from the GST portal');
    const when = toDate(b.ewb_date) ?? new Date();
    result = { ewb_no: b.ewb_no, ewb_date: when, valid_upto: toDate(b.valid_upto) ?? (e0.vehicle_no || e0.transport_doc_no ? validityUpto(when, n(e0.distance_km), e0.vehicle_type) : null) };
  }
  await transaction(async (tx) => {
    const e = await lockEwb(tx, cid, id);
    if (e.status !== 'DRAFT') throw BadRequest('This e-way bill was generated meanwhile');
    const dup = await txQueryOne<any>(tx, `SELECT doc_no FROM trx_eway_bill WHERE company_id = ? AND ewb_no = ? AND id <> ?`, [cid, result.ewb_no, id]);
    if (dup) throw BadRequest(`E-way bill number ${result.ewb_no} is already on ${dup.doc_no}`);
    await txExecute(tx, `UPDATE trx_eway_bill SET status = 'GENERATED', ewb_no = ?, ewb_date = ?, valid_upto = ?, ewb_url = ?, provider = ?, last_error = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [result.ewb_no, result.ewb_date ?? new Date(), result.valid_upto ?? null, result.url ?? null, provider.code, req.user!.id, id]);
    const col = SOURCE_EWB_COLUMN[e.source_type as SourceType];
    if (col && e.source_id) await txExecute(tx, `UPDATE ${col[0]} SET ${col[1]} = ? WHERE id = ? AND company_id = ?`, [result.ewb_no, e.source_id, cid]);
    await logEvent(tx, id, provider.online ? 'GENERATE' : 'RECORD', provider.code, true, `E-way bill ${result.ewb_no}`, result.request ?? b, result.raw ?? null, req.user!.id);
    await audit(req, 'trx_eway_bill', id, 'UPDATE', { status: 'DRAFT' }, { status: 'GENERATED', ewb_no: result.ewb_no, provider: provider.code }, tx);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

/** Cancel — only within 24 hours of generation (GST rule); the number is cleared from the source document. */
ewayBillRouter.post('/eway-bills/:id/cancel', requirePermission('EWAY.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const b = z.object({ reason: z.enum(CANCEL_REASONS), remark: z.string().trim().min(3, 'Give a remark (at least 3 characters)').max(100) }).parse(req.body ?? {});
  const provider = await providerFor(cid);
  const e0 = await loadEwb(cid, id);
  if (e0.status !== 'GENERATED') throw BadRequest(`Only a generated e-way bill is cancelled (this one is ${e0.status})`);
  if (!e0.can_cancel) throw BadRequest('An e-way bill can be cancelled only within 24 hours of generation — after that it lapses on its own or the recipient rejects it');
  let result: any = {};
  if (provider.online && e0.provider === provider.code) {
    try { result = await provider.cancel(e0, b.reason, b.remark); } catch (err) { await logFailure(id, 'CANCEL', provider.code, err, req.user!.id); throw err; }
  }
  await transaction(async (tx) => {
    const e = await lockEwb(tx, cid, id);
    if (e.status !== 'GENERATED') throw BadRequest('This e-way bill changed meanwhile');
    await txExecute(tx, `UPDATE trx_eway_bill SET status = 'CANCELLED', cancel_reason = ?, cancel_remark = ?, cancelled_at = NOW(), cancelled_by = ?, updated_at = NOW() WHERE id = ?`,
      [b.reason, b.remark, req.user!.id, id]);
    const col = SOURCE_EWB_COLUMN[e.source_type as SourceType];
    if (col && e.source_id) await txExecute(tx, `UPDATE ${col[0]} SET ${col[1]} = NULL WHERE id = ? AND company_id = ? AND ${col[1]} = ?`, [e.source_id, cid, e.ewb_no]);
    await logEvent(tx, id, 'CANCEL', e.provider ?? provider.code, true, `${b.reason}: ${b.remark}`, result.request ?? b, result.raw ?? null, req.user!.id);
    await audit(req, 'trx_eway_bill', id, 'UPDATE', { status: 'GENERATED' }, { status: 'CANCELLED', reason: b.reason, remark: b.remark }, tx);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

const partBSchema = z.object({
  vehicle_no: z.string().trim().max(20).default(''), vehicle_type: z.enum(['Regular', 'ODC']).default('Regular'),
  transport_mode: z.enum(['Road', 'Rail', 'Air', 'Ship']).default('Road'),
  transport_doc_no: z.string().trim().max(15).nullish(), transport_doc_date: dateStr.nullish(),
  from_place: z.string().trim().min(1, 'Place the vehicle starts from').max(50), from_state: z.string().trim().max(50),
  reason: z.enum(VEHICLE_REASONS), remark: z.string().trim().max(50).nullish(),
  valid_upto: z.string().trim().optional(),
});
/** Part B: vehicle (or transport document) update — first time, breakdown, transhipment. */
ewayBillRouter.post('/eway-bills/:id/part-b', requirePermission('EWAY.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const b = partBSchema.parse(req.body ?? {});
  const vehicle = cleanVehicle(b.vehicle_no);
  if (b.transport_mode === 'Road' && !VEHICLE_RE.test(vehicle)) throw BadRequest(`Vehicle number "${b.vehicle_no}" is not in the RTO format (e.g. TN39AB1234)`);
  if (b.transport_mode !== 'Road' && !b.transport_doc_no) throw BadRequest('Rail / air / ship needs the transport document number and date');
  if (!stateName(b.from_state)) throw BadRequest('State the vehicle starts from');
  const provider = await providerFor(cid);
  const e0 = await loadEwb(cid, id);
  if (!e0.can_part_b) throw BadRequest(`Vehicle can be updated only on an active e-way bill (this one is ${e0.view_status})`);
  const p = { ...b, vehicle_no: vehicle, from_state: stateName(b.from_state) };
  let result: any = {};
  if (provider.online && e0.provider === provider.code) {
    try { result = await provider.updatePartB(e0, p); } catch (err) { await logFailure(id, 'PART_B', provider.code, err, req.user!.id); throw err; }
  }
  // the first Part B starts the validity (Part-A-only bill); later updates keep it
  const valid = result.valid_upto ?? toDate(b.valid_upto) ?? (e0.valid_upto ? new Date(e0.valid_upto) : validityUpto(new Date(), n(e0.distance_km), b.vehicle_type));
  await transaction(async (tx) => {
    await lockEwb(tx, cid, id);
    await txExecute(tx, `UPDATE trx_eway_bill SET vehicle_no = ?, vehicle_type = ?, transport_mode = ?, transport_doc_no = ?, transport_doc_date = ?, valid_upto = ?, ewb_url = COALESCE(?, ewb_url), last_error = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [b.transport_mode === 'Road' ? vehicle : (vehicle || null), b.vehicle_type, b.transport_mode, b.transport_doc_no ?? null, b.transport_doc_date ?? null, valid, result.url ?? null, req.user!.id, id]);
    await logEvent(tx, id, 'PART_B', e0.provider ?? provider.code, true, `${vehicle || b.transport_doc_no} — ${b.reason}`, result.request ?? p, result.raw ?? null, req.user!.id);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

const extendSchema = z.object({
  remaining_km: z.coerce.number().int().min(1, 'Remaining distance is required').max(4000),
  reason: z.enum(EXTEND_REASONS), remark: z.string().trim().min(3, 'Give a remark').max(50),
  consignment_status: z.enum(['M', 'T']).default('M'), transit_type: z.enum(['R', 'W', 'O']).nullish(),
  from_place: z.string().trim().min(1).max(50), from_state: z.string().trim().max(50), from_pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'PIN code of the current place'),
  vehicle_no: z.string().trim().max(20).nullish(), transport_mode: z.enum(['Road', 'Rail', 'Air', 'Ship']).default('Road'),
  transport_doc_no: z.string().trim().max(15).nullish(), transport_doc_date: dateStr.nullish(),
  address1: z.string().trim().max(120).nullish(), address2: z.string().trim().max(120).nullish(), address3: z.string().trim().max(120).nullish(),
  valid_upto: z.string().trim().optional(),
});
/** Extend validity — from 8 hours before to 8 hours after it ends (GST rule); new validity from the remaining distance. */
ewayBillRouter.post('/eway-bills/:id/extend', requirePermission('EWAY.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const b = extendSchema.parse(req.body ?? {});
  if (b.consignment_status === 'M' && !b.vehicle_no) throw BadRequest('In movement: give the vehicle number');
  if (b.consignment_status === 'T' && !b.transit_type) throw BadRequest('In transit: say where the goods are (road / warehouse / other)');
  const provider = await providerFor(cid);
  const e0 = await loadEwb(cid, id);
  if (e0.status !== 'GENERATED') throw BadRequest(`Only a generated e-way bill is extended (this one is ${e0.status})`);
  if (!e0.can_extend) throw BadRequest('Validity can be extended only from 8 hours before to 8 hours after it ends');
  const p = { ...b, vehicle_no: b.vehicle_no ? cleanVehicle(b.vehicle_no) : null, from_state: stateName(b.from_state) };
  let result: any = {};
  if (provider.online && e0.provider === provider.code) {
    try { result = await provider.extend(e0, p as any); } catch (err) { await logFailure(id, 'EXTEND', provider.code, err, req.user!.id); throw err; }
  }
  const base = new Date(Math.max(Date.now(), new Date(e0.valid_upto).getTime()));
  const valid = result.valid_upto ?? toDate(b.valid_upto) ?? validityUpto(new Date(), b.remaining_km, e0.vehicle_type) ?? base;
  await transaction(async (tx) => {
    await lockEwb(tx, cid, id);
    await txExecute(tx, `UPDATE trx_eway_bill SET valid_upto = ?, vehicle_no = COALESCE(?, vehicle_no), ewb_url = COALESCE(?, ewb_url), last_error = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [valid, p.vehicle_no, result.url ?? null, req.user!.id, id]);
    await logEvent(tx, id, 'EXTEND', e0.provider ?? provider.code, true, `${b.reason}: ${b.remark} — ${b.remaining_km} km left`, result.request ?? p, result.raw ?? null, req.user!.id);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

/** Refresh from the portal (online provider only). */
ewayBillRouter.post('/eway-bills/:id/refresh', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId; const id = ewbId(req.params.id);
  const provider = await providerFor(cid);
  const e0 = await loadEwb(cid, id);
  if (!e0.ewb_no) throw BadRequest('Not generated yet');
  if (!provider.online) throw BadRequest('Manual mode: check the e-way bill on the GST portal');
  let r: any;
  try { r = await provider.fetch(e0); } catch (err) { await logFailure(id, 'REFRESH', provider.code, err, req.user!.id); throw err; }
  await transaction(async (tx) => {
    await txExecute(tx, `UPDATE trx_eway_bill SET valid_upto = COALESCE(?, valid_upto), last_error = NULL WHERE id = ?`, [r.valid_upto ?? null, id]);
    await logEvent(tx, id, 'REFRESH', provider.code, true, null, null, r.raw ?? null, req.user!.id);
  });
  res.json({ data: await loadEwb(cid, id) });
}));

/** Count of e-way bills expiring in the next 12 hours / already expired today (dashboard / register banner). */
ewayBillRouter.get('/eway-bills-alerts', requirePermission('EWAY.VIEW'), ah(async (req, res) => {
  const r = await queryOne<any>(
    `SELECT SUM(valid_upto > NOW() AND valid_upto < NOW() + INTERVAL 12 HOUR) expiring, SUM(valid_upto <= NOW() AND valid_upto > NOW() - INTERVAL 8 HOUR) just_expired
       FROM trx_eway_bill WHERE company_id = ? AND status = 'GENERATED'`, [req.user!.companyId]);
  res.json({ data: { expiring: n(r?.expiring), just_expired: n(r?.just_expired) } });
}));

