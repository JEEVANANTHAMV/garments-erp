import { Router, type Request } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, queryOne, transaction, txExecute, txQuery, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Forbidden, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { s } from '../resources/schemas.js';
import { yarnJobLots, resolveSoId } from '../stock/jobStock.routes.js';
import { postKnittingDc } from './knittingDc.routes.js';
import { contractorSnapshot, dcAudit, jobSnapshot, yarnDescription } from './knitDcSnapshots.js';
import { renderYarnIssueDcPdf, type YarnIssueDcPdf } from './yarnIssueDcPdf.js';

/**
 * Knitting Yarn Issue DC (C-ONE ERP developer specification, 04-Nov-2026) — /knitting/yarn-issue-dcs.
 *
 * The same knitting DC as before (trx_knitting_dc + trx_knitting_dc_job + stock issues in trx_process_issue,
 * so gate pass, grey fabric inward, yarn returns, reconciliation and the knitting bill keep working), now with:
 *   - a DRAFT stage: header + lines (many jobs) saved without moving stock; approval issues the yarn;
 *   - description snapshots per line (job no, yarn, fabric, lot from the lot data only, cones, net KG);
 *   - no rate / amount / gross weight on the outward DC (the server refuses them; the knitting rate comes
 *     from the approved quotation at fabric inward);
 *   - approved-DC edits only with permission + reason, cancel with reason (stock reversed), full audit;
 *   - an e-way bill section (manual capture of a portal EWB, attachment, expiry status, own audit);
 *   - the A4 portrait PDF (yarnIssueDcPdf.ts).
 */
export const yarnIssueDcRouter = Router();

const BASE = '/knitting/yarn-issue-dcs';
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const has = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
const DC_READY = ['RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED'];
export const DEFAULT_PURPOSE = 'Yarn Issue for Knitting';

/* ================================================================
   Validation helpers
================================================================ */

/** Rate / amount / gross weight never belong on the outward yarn DC (spec §2, §10). */
const FORBIDDEN_KEY = /^(rate|rates|rate_per_kg|knitting_rate|amount|amounts|value|line_amount|total_amount|taxable_amount|gross_weight|gross_weight_kg|gross_kg)$/i;
function rejectPricing(body: unknown) {
  const found: string[] = [];
  const walk = (o: unknown, at: string) => {
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (FORBIDDEN_KEY.test(k) && v !== null && v !== undefined && v !== '') found.push(`${at}${at ? '.' : ''}${k}`);
        walk(v, `${at}${at ? '.' : ''}${k}`);
      }
    }
  };
  walk(body, '');
  if (found.length) {
    throw BadRequest(`Rate, amount and gross weight are not allowed on the knitting yarn issue DC (${found.slice(0, 4).join(', ')}) — ` +
      'the knitting rate is taken from the approved quotation at knitted fabric inward');
  }
}

/** GSTIN / transporter ID: 15 characters, state code, PAN, entity, Z, check character (mod-36 checksum). */
const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
export function validGstin(v: string) {
  const g = v.toUpperCase();
  if (!GSTIN_RE.test(g)) return false;
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = cs.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return cs[(36 - (sum % 36)) % 36] === g[14];
}

const lineIn = z.object({
  id: s.id(),
  program_id: s.idReq(),
  program_yarn_id: s.id(),
  yarn_id: s.idReq(),
  grn_line_id: s.id(),
  lot_no: s.nullableStr(80),
  yarn_description: s.nullableStr(500),
  fabric_description: s.nullableStr(500),
  cones: z.coerce.number({ error: 'Cones must be a number' }).int('Cones must be a whole number').min(0, 'Cones cannot be negative').default(0),
  net_weight_kg: z.coerce.number({ error: 'Net weight must be a number' }).positive('Net weight must be more than 0').max(1_000_000),
  remarks: s.nullableStr(255),
});
const dcIn = z.object({
  dc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DC date is required'),
  vendor_id: s.idReq(),
  contractor_address: s.nullableStr(600),
  vehicle_no: s.nullableStr(30),
  purpose: s.nullableStr(150),
  warehouse_id: s.idReq(),
  remarks: s.text(),
  allow_override: z.coerce.boolean().default(false),
  override_reason: s.nullableStr(255),
  lines: z.array(lineIn).min(1, 'Add at least one line').max(300),
  /** reason for changing an approved DC */
  reason: s.nullableStr(500),
});
type DcIn = z.infer<typeof dcIn>;
type LineIn = z.infer<typeof lineIn>;

const vehicle = (v: string | null | undefined) => (v ? v.toUpperCase().replace(/\s+/g, ' ').trim() : null);

/** Checks every line (valid job, yarn, lot of that yarn) and works out its snapshots. */
async function normaliseLines(req: Request, lines: LineIn[]) {
  const cid = req.user!.companyId;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tag = `Line ${i + 1}`;
    const job = await jobSnapshot(cid, l.program_id);
    if (!job) throw BadRequest(`${tag}: job (knitting program) not found`);
    if (['CANCELLED', 'COMPLETED'].includes(job.status)) throw BadRequest(`${tag}: program ${job.program_no} is ${String(job.status).toLowerCase()}`);
    const y = await queryOne<any>('SELECT id FROM mst_yarn WHERE id = ? AND company_id = ?', [l.yarn_id, cid]);
    if (!y) throw BadRequest(`${tag}: yarn not found`);
    if (l.program_yarn_id) {
      const py = await queryOne<any>('SELECT id, yarn_id FROM trx_knitting_program_yarns WHERE id = ? AND program_id = ?', [l.program_yarn_id, l.program_id]);
      if (!py) throw BadRequest(`${tag}: the yarn line is not on program ${job.program_no}`);
      if (py.yarn_id && Number(py.yarn_id) !== Number(l.yarn_id)) {
        const sub = await queryOne<any>(`SELECT id FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ? AND substitute_yarn_id = ? AND status = 'POSTED' LIMIT 1`,
          [cid, l.program_yarn_id, l.yarn_id]);
        if (!sub) throw BadRequest(`${tag}: this yarn is not the program's yarn and no approved substitution exists`);
      }
    }
    // lot number only from the lot (GRN) data — never typed or generated
    let lot: string | null = null;
    if (l.grn_line_id) {
      const gl = await queryOne<any>(
        `SELECT gl.lot_no, gl.yarn_id FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id WHERE gl.id = ? AND g.company_id = ?`, [l.grn_line_id, cid]);
      if (!gl) throw BadRequest(`${tag}: yarn lot not found`);
      if (gl.yarn_id && Number(gl.yarn_id) !== Number(l.yarn_id)) throw BadRequest(`${tag}: the lot picked is of another yarn`);
      lot = gl.lot_no ? String(gl.lot_no) : null;
      if (l.lot_no && lot && l.lot_no.trim() !== lot) throw BadRequest(`${tag}: lot no ${l.lot_no} does not match the lot picked (${lot}) — the lot no comes from the lot data`);
    } else if (l.lot_no) {
      throw BadRequest(`${tag}: pick the yarn lot from stock — a lot number cannot be typed in`);
    }
    if (Math.abs(l.net_weight_kg * 1000 - Math.round(l.net_weight_kg * 1000)) > 1e-6) throw BadRequest(`${tag}: net weight takes up to 3 decimals`);
    const yarnDef = await yarnDescription(l.yarn_id, l.program_yarn_id ?? null);
    const fabDef = job.fabric_description;
    const yarnDesc = l.yarn_description?.trim() || yarnDef;
    const fabDesc = l.fabric_description?.trim() || fabDef;
    out.push({ ...l, job, lot_no: lot, yarn_default: yarnDef, fabric_default: fabDef, yarn_description: yarnDesc, fabric_description: fabDesc,
      net_weight_kg: r3(l.net_weight_kg) });
  }
  return out;
}
type NormLine = Awaited<ReturnType<typeof normaliseLines>>[number];

async function loadDc(cid: number, id: number) {
  const h = await queryOne<any>(
    `SELECT kd.*, w.warehouse_name, p.party_name AS vendor_name, p.gstin AS vendor_gstin,
            uc.full_name AS created_by_name, ua.full_name AS approved_by_name, ux.full_name AS cancelled_by_name
       FROM trx_knitting_dc kd LEFT JOIN mst_warehouse w ON w.id = kd.warehouse_id LEFT JOIN mst_party p ON p.id = kd.vendor_id
       LEFT JOIN mst_user uc ON uc.id = kd.created_by LEFT JOIN mst_user ua ON ua.id = kd.approved_by LEFT JOIN mst_user ux ON ux.id = kd.cancelled_by
      WHERE kd.id = ? AND kd.company_id = ?`, [id, cid]);
  if (!h) throw NotFound('Knitting yarn issue DC not found');
  const lines = await query<any>(
    `SELECT l.*, kp.program_no, kp.io_no, kp.status AS program_status, y.yarn_code, y.yarn_name
       FROM trx_knitting_dc_line l LEFT JOIN trx_knitting_program kp ON kp.id = l.program_id LEFT JOIN mst_yarn y ON y.id = l.yarn_id
      WHERE l.dc_id = ? ORDER BY l.line_no, l.id`, [id]);
  for (const l of lines) { l.cones = n(l.cones); l.net_weight_kg = n(l.net_weight_kg); }
  return { h, lines };
}

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw NotFound('Knitting yarn issue DC not found');
  return id;
};

/* ================================================================
   E-way bill helpers
================================================================ */
const EWB_TZ = 'Asia/Kolkata';
const IST_MIN = 330;
/** "2026-11-03T10:24" entered in IST → UTC "2026-11-03 04:54:00" for the DATETIME column (pool timezone is UTC). */
function istToUtc(local: string | null | undefined) {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local);
  if (!m) throw BadRequest(`Date-time "${local}" is not valid (use YYYY-MM-DDTHH:mm)`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_MIN * 60000;
  return new Date(t);
}
const toDate = (v: unknown) => (v ? (v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}Z`)) : null);
/** UTC instant → "2026-11-03T10:24" in IST (for the form). */
function utcToIstLocal(v: unknown) {
  const d = toDate(v); if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_MIN * 60000).toISOString().slice(0, 16);
}
/** "03-Nov-2026 10:24 AM" in IST (print / screen). */
export function istText(v: unknown) {
  const d = toDate(v); if (!d || Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: EWB_TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod ?? '').toUpperCase()}`.trim();
}
const NEAR_EXPIRY_HOURS = 6;

function ewbView(e: any | null, dcStatus?: string) {
  if (!e) return { is_required: false, status: 'NOT_REQUIRED', view_status: 'NOT_REQUIRED', expired: false, near_expiry: false };
  const until = toDate(e.valid_until);
  const now = Date.now();
  const expired = !!until && until.getTime() < now;
  const near = !!until && !expired && until.getTime() - now < NEAR_EXPIRY_HOURS * 3600_000;
  const view = e.status === 'CANCELLED' || dcStatus === 'CANCELLED' ? 'CANCELLED' : !e.is_required ? 'NOT_REQUIRED' : e.status === 'ENTERED' ? (expired ? 'EXPIRED' : 'ENTERED') : 'PENDING';
  return {
    ...e, is_required: !!e.is_required, same_as_dc_vehicle: !!e.same_as_dc_vehicle, approx_distance_km: e.approx_distance_km == null ? null : n(e.approx_distance_km),
    eway_bill_datetime_local: utcToIstLocal(e.eway_bill_datetime), valid_until_local: utcToIstLocal(e.valid_until),
    eway_bill_datetime_text: istText(e.eway_bill_datetime), valid_until_text: istText(e.valid_until),
    has_attachment: !!e.attachment_key, has_qr: !!e.qr_payload, expired, near_expiry: near, view_status: view,
    attachment_key: undefined, qr_payload: undefined,
  };
}

/** QR content only from a verified source: a QR string inside the official API response stored by the e-way bill module. */
async function verifiedQr(ewbId: number): Promise<{ payload: string; source: string } | null> {
  const evs = await query<any>(`SELECT response FROM trx_eway_bill_event WHERE ewb_id = ? AND ok = 1 AND response IS NOT NULL AND provider <> 'MANUAL' ORDER BY id DESC LIMIT 5`, [ewbId]);
  const find = (o: any, depth = 0): string | null => {
    if (!o || typeof o !== 'object' || depth > 5) return null;
    for (const [k, v] of Object.entries(o)) {
      if (/^(qr|qrcode|qr_code|qrCode|QRCode|qrData)$/i.test(k) && typeof v === 'string' && v.length > 10 && !/^https?:/i.test(v)) return v;
      const x = find(v, depth + 1); if (x) return x;
    }
    return null;
  };
  for (const e of evs) {
    const r = typeof e.response === 'string' ? (() => { try { return JSON.parse(e.response); } catch { return null; } })() : e.response;
    const q = find(r);
    if (q) return { payload: q, source: 'EWB_PROVIDER_RESPONSE' };
  }
  return null;
}

const EWB_DIR = () => path.resolve(process.cwd(), 'uploads', 'knit-dc-ewb');
const EWB_EXT: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  '.pdf': { mime: 'application/pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  '.png': { mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  '.jpeg': { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
};
function ewbFile(key: string) {
  const p = path.resolve(EWB_DIR(), key);
  if (!p.startsWith(EWB_DIR() + path.sep)) throw NotFound('File not found');
  return p;
}

/** After approval, e-way bill changes need a reason and the right (spec §15.2, §15.7). */
function assertEwbChangeAllowed(req: Request, dc: any, reason: string | null | undefined) {
  if (dc.doc_status === 'CANCELLED') throw BadRequest(`DC ${dc.dc_no} is cancelled — its e-way bill cannot change`);
  if (dc.doc_status === 'APPROVED') {
    if (!has(req, 'KNIT_DC.EDIT_APPROVED') && !has(req, 'EWAY.UPDATE')) throw Forbidden('You are not allowed to change the e-way bill of an approved DC');
    if (!reason || reason.trim().length < 5) throw BadRequest('Give the reason for changing the e-way bill of an approved DC (min 5 characters)');
  }
}

/* ================================================================
   LIST / DEFAULTS
================================================================ */

yarnIssueDcRouter.get(BASE, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dc_no: z.string().trim().max(60).optional(), contractor_id: z.coerce.number().int().positive().optional(),
    job: z.string().trim().max(80).optional(), status: z.enum(['DRAFT', 'APPROVED', 'CANCELLED']).optional(),
    program_id: z.coerce.number().int().positive().optional(),
  }).parse(req.query);
  let where = 'WHERE kd.company_id = ?'; const p: any[] = [cid];
  if (q.from) { where += ' AND kd.dc_date >= ?'; p.push(q.from); }
  if (q.to) { where += ' AND kd.dc_date <= ?'; p.push(q.to); }
  if (q.dc_no) { where += ' AND kd.dc_no LIKE ?'; p.push(`%${q.dc_no}%`); }
  if (q.contractor_id) { where += ' AND kd.vendor_id = ?'; p.push(q.contractor_id); }
  if (q.status) { where += ' AND kd.doc_status = ?'; p.push(q.status); }
  if (q.job) { where += ' AND EXISTS (SELECT 1 FROM trx_knitting_dc_line l2 WHERE l2.dc_id = kd.id AND l2.job_no_snapshot LIKE ?)'; p.push(`%${q.job}%`); }
  if (q.program_id) { where += ' AND EXISTS (SELECT 1 FROM trx_knitting_dc_line l3 WHERE l3.dc_id = kd.id AND l3.program_id = ?)'; p.push(q.program_id); }
  const rows = await query<any>(
    `SELECT kd.id, kd.dc_no, kd.dc_date, kd.doc_status, kd.status AS receipt_status, kd.vendor_id, COALESCE(kd.contractor_name_snapshot, pt.party_name) AS contractor,
            kd.vehicle_no, kd.purpose, kd.print_count, kd.created_at, kd.approved_at, kd.cancel_reason,
            (SELECT COUNT(*) FROM trx_knitting_dc_line l WHERE l.dc_id = kd.id) AS line_count,
            (SELECT COALESCE(SUM(l.cones), 0) FROM trx_knitting_dc_line l WHERE l.dc_id = kd.id) AS total_cones,
            (SELECT COALESCE(SUM(l.net_weight_kg), 0) FROM trx_knitting_dc_line l WHERE l.dc_id = kd.id) AS total_net_kg,
            (SELECT GROUP_CONCAT(DISTINCT l.job_no_snapshot ORDER BY l.line_no SEPARATOR ', ') FROM trx_knitting_dc_line l WHERE l.dc_id = kd.id) AS jobs,
            e.is_required AS ewb_required, e.status AS ewb_status, e.eway_bill_no, e.valid_until AS ewb_valid_until
       FROM trx_knitting_dc kd LEFT JOIN mst_party pt ON pt.id = kd.vendor_id
       LEFT JOIN trx_knitting_dc_eway e ON e.dc_id = kd.id
       ${where} ORDER BY kd.id DESC LIMIT 500`, p);
  for (const r of rows) {
    r.total_net_kg = r3(n(r.total_net_kg)); r.total_cones = n(r.total_cones);
    const v = ewbView(r.ewb_status ? { is_required: r.ewb_required, status: r.ewb_status, valid_until: r.ewb_valid_until } : null, r.doc_status);
    r.ewb_view_status = v.view_status; r.ewb_near_expiry = v.near_expiry;
    delete r.ewb_valid_until;
  }
  res.json({ success: true, data: rows });
}));

/** Defaults for a job line: the program's yarns with description, pending KG, fabric description and the job's yarn lots. */
yarnIssueDcRouter.get(`${BASE}/job-defaults/:programId`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const job = await jobSnapshot(cid, Number(req.params.programId));
  if (!job) throw NotFound('Knitting program not found');
  const yarns = await query<any>(
    `SELECT kpy.id AS program_yarn_id, kpy.yarn_id, kpy.colour, kpy.planned_qty_kg, kpy.issued_qty_kg, y.yarn_code, y.yarn_name
       FROM trx_knitting_program_yarns kpy LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id WHERE kpy.program_id = ? AND kpy.yarn_id IS NOT NULL ORDER BY kpy.seq_no, kpy.id`, [job.id]);
  const subs = await query<any>(`SELECT s.program_yarn_id, s.substitute_yarn_id, y.yarn_name FROM trx_yarn_substitution s LEFT JOIN mst_yarn y ON y.id = s.substitute_yarn_id
                                   WHERE s.company_id = ? AND s.program_yarn_id IN (?) AND s.status = 'POSTED' AND s.qty_kg > s.issued_kg`,
    [cid, yarns.length ? yarns.map((y) => y.program_yarn_id) : [0]]);
  const soId = await resolveSoId(cid, job.so_id, job.io_no);
  const ids = new Set<number>([...yarns.map((y) => Number(y.yarn_id)), ...subs.map((x) => Number(x.substitute_yarn_id))]);
  const lots = ids.size ? (await yarnJobLots(cid, { so_id: soId ?? 0, includeGeneral: true })).filter((l: any) => ids.has(Number(l.yarn_id))) : [];
  const out = [];
  for (const y of yarns) {
    out.push({ ...y, pending_kg: r3(Math.max(0, n(y.planned_qty_kg) - n(y.issued_qty_kg))), yarn_description: await yarnDescription(Number(y.yarn_id), Number(y.program_yarn_id)),
      substitutes: subs.filter((x) => Number(x.program_yarn_id) === Number(y.program_yarn_id)).map((x) => ({ yarn_id: Number(x.substitute_yarn_id), yarn_name: x.yarn_name })) });
  }
  res.json({ success: true, data: {
    program_id: job.id, program_no: job.program_no, io_no: job.io_no, job_no: job.job_no, status: job.status, vendor_id: job.vendor_id,
    ready: DC_READY.includes(job.status), fabric_description: job.fabric_description, yarns: out, lots,
  } });
}));

/** DC id from its number (the program screens know the DC by number). */
yarnIssueDcRouter.get(`${BASE}/by-no/:dcNo`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const r = await queryOne<any>('SELECT id, dc_no, doc_status FROM trx_knitting_dc WHERE company_id = ? AND dc_no = ?', [req.user!.companyId, String(req.params.dcNo)]);
  if (!r) throw NotFound('Knitting DC not found');
  res.json({ success: true, data: r });
}));

/** Contractor name / address / GSTIN for the header auto-fill. */
yarnIssueDcRouter.get(`${BASE}/contractor/:partyId`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const c = await contractorSnapshot(req.user!.companyId, Number(req.params.partyId));
  if (!c) throw NotFound('Contractor not found');
  res.json({ success: true, data: c });
}));

/* ================================================================
   CREATE / READ / UPDATE
================================================================ */

async function checkHeader(req: Request, b: DcIn) {
  const cid = req.user!.companyId;
  const party = await queryOne<any>('SELECT id, is_vendor, is_contractor, is_supplier FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0', [b.vendor_id, cid]);
  if (!party) throw BadRequest('Contractor not found');
  if (!Number(party.is_vendor) && !Number(party.is_contractor) && !Number(party.is_supplier)) throw BadRequest('The party is not a job worker / contractor');
  const wh = await queryOne<any>('SELECT id FROM mst_warehouse WHERE id = ? AND company_id = ?', [b.warehouse_id, cid]);
  if (!wh) throw BadRequest('Store (warehouse) not found');
  if (b.allow_override && !b.override_reason) throw BadRequest('An override reason is required to issue beyond available stock');
  return contractorSnapshot(cid, b.vendor_id);
}

function descEditCheck(req: Request, lines: NormLine[], before?: Map<number, any>) {
  if (has(req, 'KNIT_DC.EDIT_DESC') || has(req, 'KNIT_DC.EDIT_APPROVED')) return;
  for (const l of lines) {
    const prev = l.id ? before?.get(Number(l.id)) : null;
    const okYarn = l.yarn_description === l.yarn_default || (prev && prev.yarn_description_snapshot === l.yarn_description);
    const okFab = l.fabric_description === l.fabric_default || (prev && prev.fabric_description_snapshot === l.fabric_description);
    if (!okYarn || !okFab) throw Forbidden('You are not allowed to change the yarn / fabric description on the DC (KNIT_DC.EDIT_DESC)');
  }
}

async function insertLines(tx: any, cid: number, dcId: number, dcNo: string, lines: NormLine[]) {
  let no = 0;
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_knitting_dc_line (company_id, dc_id, dc_no, line_no, program_id, program_yarn_id, so_id, job_no_snapshot, yarn_id, grn_line_id, lot_no,
         yarn_description_snapshot, fabric_description_snapshot, cones, net_weight_kg, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, dcId, dcNo, ++no, l.program_id, l.program_yarn_id ?? null, l.job.so_id ?? null, l.job.job_no, l.yarn_id, l.grn_line_id ?? null, l.lot_no,
       l.yarn_description, l.fabric_description, l.cones, l.net_weight_kg, l.remarks ?? null]);
  }
}

const headerJson = (h: any) => ({ dc_date: h.dc_date, vendor_id: h.vendor_id, contractor_address: h.contractor_address_snapshot, vehicle_no: h.vehicle_no,
  purpose: h.purpose, warehouse_id: h.warehouse_id, remarks: h.remarks });
const lineJson = (l: any) => ({ id: l.id, line_no: l.line_no, program_id: l.program_id, job_no: l.job_no_snapshot, yarn_id: l.yarn_id, grn_line_id: l.grn_line_id,
  lot_no: l.lot_no, yarn_description: l.yarn_description_snapshot, fabric_description: l.fabric_description_snapshot, cones: n(l.cones), net_weight_kg: n(l.net_weight_kg) });

yarnIssueDcRouter.post(BASE, requirePermission('PROCESS.ISSUE'), ah(async (req, res) => {
  rejectPricing(req.body);
  const cid = req.user!.companyId; const uid = req.user!.id;
  const b = dcIn.parse(req.body);
  const c = await checkHeader(req, b);
  const lines = await normaliseLines(req, b.lines);
  descEditCheck(req, lines);
  const out = await transaction(async (tx) => {
    const dcNo = await nextDocNumber(tx, cid, 'KNIT_DC');
    if (await txQueryOne<any>(tx, 'SELECT id FROM trx_knitting_dc WHERE company_id = ? AND dc_no = ?', [cid, dcNo])
      || await txQueryOne<any>(tx, 'SELECT id FROM trx_process_issue WHERE company_id = ? AND dc_no = ? LIMIT 1', [cid, dcNo])) {
      throw BadRequest(`DC number ${dcNo} is already used — check the KNIT_DC number series`);
    }
    const r = await txExecute(tx,
      `INSERT INTO trx_knitting_dc (company_id, dc_no, dc_date, vendor_id, status, doc_status, purpose, vehicle_no, warehouse_id, contractor_name_snapshot,
         contractor_address_snapshot, contractor_gstin_snapshot, remarks, allow_override, override_reason, created_by, updated_by, updated_at)
       VALUES (?,?,?,?, 'OPEN', 'DRAFT', ?,?,?,?,?,?,?,?,?,?,?, NOW())`,
      [cid, dcNo, b.dc_date, b.vendor_id, b.purpose?.trim() || DEFAULT_PURPOSE, vehicle(b.vehicle_no), b.warehouse_id, c?.name ?? null,
       b.contractor_address?.trim() || c?.address || null, c?.gstin ?? null, b.remarks ?? null, b.allow_override ? 1 : 0, b.override_reason ?? null, uid, uid]);
    const dcId = Number(r.insertId);
    await insertLines(tx, cid, dcId, dcNo, lines);
    await dcAudit(tx, { cid, dcId, dcNo, action: 'CREATE', new: { header: headerJson({ ...b, contractor_address_snapshot: b.contractor_address }), lines: lines.map((l) => ({ program_id: l.program_id, job_no: l.job.job_no, yarn_id: l.yarn_id, lot_no: l.lot_no, cones: l.cones, net_weight_kg: l.net_weight_kg, yarn_description: l.yarn_description, fabric_description: l.fabric_description })) }, uid });
    return { id: dcId, dc_no: dcNo };
  });
  await audit(req, 'trx_knitting_dc', out.id, 'INSERT', undefined, { action: 'YARN_ISSUE_DC_DRAFT', ...out });
  res.status(201).json({ success: true, data: { ...out, doc_status: 'DRAFT' } });
}));

yarnIssueDcRouter.get(`${BASE}/:id`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { h, lines } = await loadDc(cid, idParam(req));
  const e = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [h.id]);
  const recv = await queryOne<any>(`SELECT COALESCE(SUM(m.fabric_kg), 0) fabric, COUNT(DISTINCT m.receipt_id) grns FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id
                                     WHERE r.company_id = ? AND m.dc_no = ?`, [cid, h.dc_no]);
  res.json({ success: true, data: {
    ...h, rate_per_kg: undefined, quotation_id: undefined, quotation_line_id: undefined,
    lines, eway: ewbView(e, h.doc_status),
    total_cones: lines.reduce((a, l) => a + n(l.cones), 0), total_net_kg: r3(lines.reduce((a, l) => a + n(l.net_weight_kg), 0)),
    fabric_received_kg: r3(n(recv?.fabric)), inward_count: n(recv?.grns),
    permissions: { approve: has(req, 'KNIT_DC.APPROVE'), edit_desc: has(req, 'KNIT_DC.EDIT_DESC'), edit_approved: has(req, 'KNIT_DC.EDIT_APPROVED'),
      cancel: has(req, 'KNIT_DC.CANCEL'), edit: has(req, 'PROCESS.ISSUE'), ewb_after_approval: has(req, 'KNIT_DC.EDIT_APPROVED') || has(req, 'EWAY.UPDATE') },
  } });
}));

yarnIssueDcRouter.get(`${BASE}/:id/audit`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = idParam(req);
  const dc = await queryOne<any>('SELECT id FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [id, cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const rows = await query<any>(`SELECT a.id, a.action, a.old_values_json, a.new_values_json, a.action_at, a.remarks, u.full_name AS user_name
                                   FROM trx_knitting_dc_audit a LEFT JOIN mst_user u ON u.id = a.user_id WHERE a.dc_id = ? ORDER BY a.id DESC`, [id]);
  const ew = await query<any>(`SELECT a.id, a.action, a.old_values_json, a.new_values_json, a.action_at, a.change_reason AS remarks, u.full_name AS user_name
                                 FROM trx_knitting_dc_eway_audit a LEFT JOIN mst_user u ON u.id = a.user_id WHERE a.dc_id = ? ORDER BY a.id DESC`, [id]);
  res.json({ success: true, data: { dc: rows, eway: ew } });
}));

/**
 * PUT — a DRAFT is saved as sent (header + all lines). An APPROVED DC (stock already issued) takes only
 * the printable fields — vehicle, purpose, contractor address, remarks and the line descriptions — with the
 * KNIT_DC.EDIT_APPROVED right and a reason; lines / quantities / lots / jobs cannot change (cancel and re-issue).
 */
yarnIssueDcRouter.put(`${BASE}/:id`, requireAny('PROCESS.ISSUE', 'KNIT_DC.EDIT_APPROVED'), ah(async (req, res) => {
  rejectPricing(req.body);
  const cid = req.user!.companyId; const uid = req.user!.id;
  const id = idParam(req);
  const { h, lines: before } = await loadDc(cid, id);
  const b = dcIn.parse(req.body);
  if (h.doc_status === 'CANCELLED') throw BadRequest(`DC ${h.dc_no} is cancelled`);

  if (h.doc_status === 'DRAFT') {
    if (!has(req, 'PROCESS.ISSUE')) throw Forbidden('Missing required permission: PROCESS.ISSUE');
    const c = await checkHeader(req, b);
    const lines = await normaliseLines(req, b.lines);
    descEditCheck(req, lines, new Map(before.map((l) => [Number(l.id), l])));
    await transaction(async (tx) => {
      const cur = await txQueryOne<any>(tx, 'SELECT doc_status FROM trx_knitting_dc WHERE id = ? FOR UPDATE', [id]);
      if (cur?.doc_status !== 'DRAFT') throw BadRequest(`DC ${h.dc_no} is no longer a draft`);
      await txExecute(tx,
        `UPDATE trx_knitting_dc SET dc_date = ?, vendor_id = ?, purpose = ?, vehicle_no = ?, warehouse_id = ?, contractor_name_snapshot = ?, contractor_address_snapshot = ?,
                contractor_gstin_snapshot = ?, remarks = ?, allow_override = ?, override_reason = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
        [b.dc_date, b.vendor_id, b.purpose?.trim() || DEFAULT_PURPOSE, vehicle(b.vehicle_no), b.warehouse_id, c?.name ?? null,
         b.contractor_address?.trim() || c?.address || null, c?.gstin ?? null, b.remarks ?? null, b.allow_override ? 1 : 0, b.override_reason ?? null, uid, id]);
      await txExecute(tx, 'DELETE FROM trx_knitting_dc_line WHERE dc_id = ?', [id]);
      await insertLines(tx, cid, id, h.dc_no, lines);
      // a DC vehicle change follows into an e-way bill that uses the DC vehicle
      await txExecute(tx, 'UPDATE trx_knitting_dc_eway SET eway_vehicle_no = ? WHERE dc_id = ? AND same_as_dc_vehicle = 1', [vehicle(b.vehicle_no), id]);
      const after = await txQuery<any>(tx, 'SELECT * FROM trx_knitting_dc_line WHERE dc_id = ? ORDER BY line_no', [id]);
      await dcAudit(tx, { cid, dcId: id, dcNo: h.dc_no, action: 'UPDATE', old: { header: headerJson(h), lines: before.map(lineJson) },
        new: { header: headerJson({ ...b, contractor_address_snapshot: b.contractor_address?.trim() || c?.address || null, vehicle_no: vehicle(b.vehicle_no) }), lines: after.map(lineJson) }, uid });
    });
    return res.json({ success: true, data: { id, dc_no: h.dc_no, doc_status: 'DRAFT' } });
  }

  // APPROVED: printable fields only, with permission + reason
  if (!has(req, 'KNIT_DC.EDIT_APPROVED')) throw Forbidden('You are not allowed to edit an approved DC (KNIT_DC.EDIT_APPROVED)');
  if (!b.reason || b.reason.trim().length < 5) throw BadRequest('Give the reason for changing an approved DC (min 5 characters)');
  if (b.dc_date !== String(h.dc_date).slice(0, 10) || Number(b.vendor_id) !== Number(h.vendor_id) || Number(b.warehouse_id) !== Number(h.warehouse_id)) {
    throw BadRequest('DC date, contractor and store of an approved DC cannot change — cancel the DC and issue a new one');
  }
  const byId = new Map(before.map((l) => [Number(l.id), l]));
  if (b.lines.length !== before.length || b.lines.some((l) => !l.id || !byId.has(Number(l.id)))) {
    throw BadRequest('Lines of an approved DC cannot be added or removed — cancel the DC and issue a new one');
  }
  for (const l of b.lines) {
    const o = byId.get(Number(l.id))!;
    if (Number(o.program_id) !== Number(l.program_id) || Number(o.yarn_id) !== Number(l.yarn_id) || Number(o.grn_line_id ?? 0) !== Number(l.grn_line_id ?? 0)
      || n(o.cones) !== Number(l.cones) || Math.abs(n(o.net_weight_kg) - Number(l.net_weight_kg)) > 0.0005) {
      throw BadRequest(`Line ${o.line_no}: job, yarn, lot, cones and net weight of an approved DC cannot change (stock is issued) — cancel the DC and issue a new one`);
    }
  }
  const veh = vehicle(b.vehicle_no);
  await transaction(async (tx) => {
    await txExecute(tx, `UPDATE trx_knitting_dc SET purpose = ?, vehicle_no = ?, contractor_address_snapshot = ?, remarks = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [b.purpose?.trim() || DEFAULT_PURPOSE, veh, b.contractor_address?.trim() || h.contractor_address_snapshot, b.remarks ?? null, uid, id]);
    for (const l of b.lines) {
      const o = byId.get(Number(l.id))!;
      await txExecute(tx, 'UPDATE trx_knitting_dc_line SET yarn_description_snapshot = ?, fabric_description_snapshot = ?, remarks = ?, updated_at = NOW() WHERE id = ?',
        [l.yarn_description?.trim() || o.yarn_description_snapshot, l.fabric_description?.trim() || o.fabric_description_snapshot, l.remarks ?? o.remarks ?? null, o.id]);
    }
    // the gate pass / DC lookup reads the vehicle from the stock issues
    if ((veh ?? '') !== (h.vehicle_no ?? '')) {
      await txExecute(tx, `UPDATE trx_process_issue SET vehicle_no = ? WHERE company_id = ? AND dc_no = ? AND src_type = 'KNITTING_PROGRAM'`, [veh, cid, h.dc_no]);
      await txExecute(tx, 'UPDATE trx_knitting_dc_eway SET eway_vehicle_no = ? WHERE dc_id = ? AND same_as_dc_vehicle = 1', [veh, id]);
    }
    const after = await txQuery<any>(tx, 'SELECT * FROM trx_knitting_dc_line WHERE dc_id = ? ORDER BY line_no', [id]);
    const hAfter = await txQueryOne<any>(tx, 'SELECT * FROM trx_knitting_dc WHERE id = ?', [id]);
    await dcAudit(tx, { cid, dcId: id, dcNo: h.dc_no, action: 'EDIT_APPROVED', old: { header: headerJson(h), lines: before.map(lineJson) },
      new: { header: headerJson(hAfter), lines: after.map(lineJson) }, uid, remarks: b.reason!.trim() });
  });
  await audit(req, 'trx_knitting_dc', id, 'UPDATE', { dc_no: h.dc_no }, { action: 'EDIT_APPROVED', reason: b.reason });
  res.json({ success: true, data: { id, dc_no: h.dc_no, doc_status: 'APPROVED' } });
}));

/* ================================================================
   APPROVE / CANCEL
================================================================ */

yarnIssueDcRouter.post(`${BASE}/:id/approve`, requirePermission('KNIT_DC.APPROVE'), ah(async (req, res) => {
  rejectPricing(req.body);
  const cid = req.user!.companyId;
  const { h, lines } = await loadDc(cid, idParam(req));
  if (h.doc_status !== 'DRAFT') throw BadRequest(`DC ${h.dc_no} is ${String(h.doc_status).toLowerCase()} — only a draft can be approved`);
  if (!lines.length) throw BadRequest('The DC has no lines');
  const b = z.object({ allow_override: z.coerce.boolean().optional(), override_reason: s.nullableStr(255) }).parse(req.body ?? {});
  // jobs in DC line order, each with its lines
  const jobs: { program_id: number; lines: any[] }[] = [];
  for (const l of lines) {
    let j = jobs.find((x) => x.program_id === Number(l.program_id));
    if (!j) { j = { program_id: Number(l.program_id), lines: [] }; jobs.push(j); }
    j.lines.push({ program_yarn_id: l.program_yarn_id ? Number(l.program_yarn_id) : null, yarn_id: Number(l.yarn_id), grn_line_id: l.grn_line_id ? Number(l.grn_line_id) : null,
      lot_no: l.lot_no ?? null, yarn_po_no: null, issued_qty_kg: n(l.net_weight_kg), no_of_cones: n(l.cones), dc_line_id: Number(l.id) });
  }
  const allow = b.allow_override ?? !!h.allow_override;
  const reason = b.override_reason ?? h.override_reason ?? null;
  const result = await postKnittingDc(req, {
    dc_date: String(h.dc_date).slice(0, 10), vendor_id: Number(h.vendor_id), vehicle_no: h.vehicle_no ?? null, warehouse_id: Number(h.warehouse_id),
    allow_override: allow, override_reason: reason, remarks: h.remarks ?? null, dc_no: h.dc_no, jobs,
  } as any, { id: Number(h.id), dc_no: h.dc_no });
  await audit(req, 'trx_knitting_dc', Number(h.id), 'UPDATE', { doc_status: 'DRAFT' }, { doc_status: 'APPROVED', issues: result.issues.map((x: any) => x.issue_no) });
  res.json({ success: true, data: { id: Number(h.id), dc_no: h.dc_no, doc_status: 'APPROVED', issues: result.issues.length } });
}));

/**
 * POST /:id/cancel — reason required. A draft is simply cancelled. An approved DC is cancelled only while
 * nothing happened on it (no fabric inward, no yarn return, no gate pass): the yarn goes back to stock
 * (reversal entries in the stock ledger), the program yarn / reservation / substitution counts are put
 * back, and the stock issue rows are removed (their full copy is kept in the audit).
 */
yarnIssueDcRouter.post(`${BASE}/:id/cancel`, requirePermission('KNIT_DC.CANCEL'), ah(async (req, res) => {
  const cid = req.user!.companyId; const uid = req.user!.id;
  const id = idParam(req);
  const { reason } = z.object({ reason: z.string({ error: 'Give the reason for cancelling' }).trim().min(5, 'Give the reason for cancelling (min 5 characters)').max(255) }).parse(req.body ?? {});
  const { h } = await loadDc(cid, id);
  if (h.doc_status === 'CANCELLED') throw BadRequest(`DC ${h.dc_no} is already cancelled`);

  if (h.doc_status === 'APPROVED') {
    const inw = await queryOne<any>('SELECT COUNT(*) c FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id WHERE r.company_id = ? AND m.dc_no = ?', [cid, h.dc_no]);
    const inw2 = await queryOne<any>(`SELECT COUNT(*) c FROM trx_process_receipt WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND ref_dc_no = ?`, [cid, h.dc_no]);
    if (n(inw?.c) || n(inw2?.c)) throw BadRequest(`Grey fabric has been received against DC ${h.dc_no} — it cannot be cancelled (close it instead)`);
    const ret = await queryOne<any>(`SELECT COUNT(*) c FROM trx_knitting_yarn_return WHERE company_id = ? AND dc_no = ? AND status <> 'CANCELLED'`, [cid, h.dc_no]);
    if (n(ret?.c)) throw BadRequest(`Yarn has been returned against DC ${h.dc_no} — cancel the yarn return first`);
    const issueIds = (await query<any>(`SELECT id FROM trx_process_issue WHERE company_id = ? AND dc_no = ? AND src_type = 'KNITTING_PROGRAM'`, [cid, h.dc_no])).map((r) => Number(r.id));
    const gp = await queryOne<any>(`SELECT GROUP_CONCAT(pass_no) passes FROM trx_gate_outward WHERE company_id = ? AND (ref_no = ? OR (ref_type = 'KNITTING_DC' AND ref_id IN (?)))`,
      [cid, h.dc_no, issueIds.length ? issueIds : [0]]);
    if (gp?.passes) throw BadRequest(`Gate pass ${gp.passes} is made for DC ${h.dc_no} — the yarn has left the gate; it cannot be cancelled`);
  }

  const out = await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, 'SELECT doc_status FROM trx_knitting_dc WHERE id = ? FOR UPDATE', [id]);
    if (cur?.doc_status !== h.doc_status) throw BadRequest(`DC ${h.dc_no} changed meanwhile — reload and try again`);
    let reversed: any[] = [];
    if (h.doc_status === 'APPROVED') {
      const issues = await txQuery<any>(tx, `SELECT * FROM trx_process_issue WHERE company_id = ? AND dc_no = ? AND src_type = 'KNITTING_PROGRAM' ORDER BY id FOR UPDATE`, [cid, h.dc_no]);
      for (const i of issues) {
        const led = await txQueryOne<any>(tx, `SELECT rate, so_id FROM trx_stock_ledger WHERE company_id = ? AND ref_type = 'PROCESS_ISSUE' AND ref_id = ? ORDER BY id LIMIT 1`, [cid, i.id]);
        await postLedger(tx, { companyId: cid, warehouseId: Number(i.warehouse_id), materialType: 'YARN', yarnId: Number(i.yarn_id), batchId: i.batch_id ?? null,
          soId: led?.so_id ?? null, txnType: 'RETURN', refType: 'KNIT_DC_CANCEL', refId: Number(i.id), qtyIn: n(i.issued_qty_kg), uomId: UOM_KG, rate: n(led?.rate), createdBy: uid });
        if (i.src_line_id) {
          await txExecute(tx, 'UPDATE trx_knitting_program_yarns SET issued_qty_kg = GREATEST(0, issued_qty_kg - ?) WHERE id = ? AND program_id = ?', [i.issued_qty_kg, i.src_line_id, i.src_id]);
          const py = await txQueryOne<any>(tx, 'SELECT yarn_id FROM trx_knitting_program_yarns WHERE id = ?', [i.src_line_id]);
          if (py?.yarn_id && Number(py.yarn_id) !== Number(i.yarn_id)) {
            // substitute yarn: give the KG back to the approved substitution (newest first)
            let left = n(i.issued_qty_kg);
            const subs = await txQuery<any>(tx, `SELECT id, issued_kg FROM trx_yarn_substitution WHERE company_id = ? AND program_yarn_id = ? AND substitute_yarn_id = ? AND status = 'POSTED' AND issued_kg > 0 ORDER BY id DESC`,
              [cid, i.src_line_id, i.yarn_id]);
            for (const sb of subs) {
              if (left <= 0.0005) break;
              const take = r3(Math.min(left, n(sb.issued_kg)));
              await txExecute(tx, 'UPDATE trx_yarn_substitution SET issued_kg = issued_kg - ? WHERE id = ?', [take, sb.id]);
              left = r3(left - take);
            }
          }
        }
        if (i.reservation_id) {
          await txExecute(tx, `UPDATE trx_process_reservation SET released_qty_kg = GREATEST(0, released_qty_kg - ?),
                                 status = CASE WHEN released_qty_kg <= 0.0005 THEN 'ACTIVE' ELSE 'PARTIAL' END WHERE id = ?`, [i.issued_qty_kg, i.reservation_id]);
        }
        reversed.push(i);
      }
      await txExecute(tx, `DELETE FROM trx_process_issue WHERE company_id = ? AND dc_no = ? AND src_type = 'KNITTING_PROGRAM'`, [cid, h.dc_no]);
      await txExecute(tx, 'DELETE FROM trx_knitting_dc_job WHERE company_id = ? AND dc_no = ?', [cid, h.dc_no]);
      // a program with no yarn out any more goes back to released
      for (const pid of [...new Set(issues.map((i) => Number(i.src_id)))]) {
        const left = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?`, [cid, pid]);
        if (!n(left?.c)) await txExecute(tx, `UPDATE trx_knitting_program SET status = 'RELEASED' WHERE id = ? AND status = 'MATERIAL_ISSUED'`, [pid]);
      }
      reversed = reversed.map((i) => ({ id: i.id, issue_no: i.issue_no, program_id: i.src_id, yarn_id: i.yarn_id, grn_line_id: i.grn_line_id, lot_no: i.lot_no,
        warehouse_id: i.warehouse_id, issued_qty_kg: n(i.issued_qty_kg), no_of_cones: n(i.no_of_cones), reservation_id: i.reservation_id }));
    }
    await txExecute(tx, `UPDATE trx_knitting_dc SET doc_status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [uid, reason, uid, id]);
    const ew = await txQueryOne<any>(tx, 'SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [id]);
    if (ew && ew.is_required) {
      await txExecute(tx, `UPDATE trx_knitting_dc_eway SET status = 'CANCELLED', updated_by = ?, updated_at = NOW() WHERE id = ?`, [uid, ew.id]);
      await txExecute(tx, `INSERT INTO trx_knitting_dc_eway_audit (company_id, eway_bill_id, dc_id, action, old_values_json, new_values_json, change_reason, user_id) VALUES (?,?,?,?,?,?,?,?)`,
        [cid, ew.id, id, 'DC_CANCELLED', JSON.stringify({ status: ew.status }), JSON.stringify({ status: 'CANCELLED' }),
         `DC cancelled: ${reason}. Cancel the statutory e-way bill on the GST portal (within 24 hours of generation).`, uid]);
    }
    await dcAudit(tx, { cid, dcId: id, dcNo: h.dc_no, action: 'CANCEL', old: { doc_status: h.doc_status, stock_issues: reversed }, new: { doc_status: 'CANCELLED', stock_reversed: reversed.length > 0 }, uid, remarks: reason });
    return { id, dc_no: h.dc_no, doc_status: 'CANCELLED', stock_reversed_kg: r3(reversed.reduce((a, i) => a + i.issued_qty_kg, 0)), lines_reversed: reversed.length,
      eway_warning: ew?.is_required && ew?.eway_bill_no ? `E-way bill ${ew.eway_bill_no} is marked cancelled here — cancel it on the GST portal too` : null };
  });
  await audit(req, 'trx_knitting_dc', id, 'UPDATE', { doc_status: h.doc_status }, { doc_status: 'CANCELLED', reason });
  res.json({ success: true, data: out });
}));

/* ================================================================
   PRINT (A4 portrait PDF)
================================================================ */

async function pdfData(cid: number, id: number, printedBy: string | null, reprintNo: number): Promise<YarnIssueDcPdf> {
  const { h, lines } = await loadDc(cid, id);
  const c = await queryOne<any>('SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state, pincode FROM mst_company WHERE id = ?', [cid]);
  const e = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [id]);
  const v = ewbView(e, h.doc_status);
  const d = String(h.dc_date ?? '').slice(0, 10);
  const dt = d ? new Date(`${d}T00:00:00Z`) : null;
  const dcDate = dt ? `${String(dt.getUTCDate()).padStart(2, '0')}-${dt.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}` : '-';
  return {
    company: { name: c?.legal_name || c?.trade_name || '', address: [c?.address_line1, c?.address_line2, c?.city, c?.state, c?.pincode].filter(Boolean).join(', '), gstin: c?.gstin ?? null },
    dc: { dc_no: h.dc_no, dc_date: dcDate, doc_status: h.doc_status, contractor: h.contractor_name_snapshot ?? h.vendor_name ?? null,
      contractor_address: h.contractor_address_snapshot ?? null, contractor_gstin: h.contractor_gstin_snapshot ?? h.vendor_gstin ?? null,
      vehicle_no: h.vehicle_no ?? null, purpose: h.purpose ?? DEFAULT_PURPOSE, cancel_reason: h.cancel_reason ?? null },
    lines: lines.map((l) => ({ job_no: l.job_no_snapshot ?? l.io_no ?? l.program_no ?? '', yarn: l.yarn_description_snapshot ?? l.yarn_name ?? '', fabric: l.fabric_description_snapshot ?? '',
      lot_no: l.lot_no ?? null, cones: n(l.cones), net_kg: n(l.net_weight_kg) })),
    // e-way bill block only when the DC needs one (spec §15.3 / §16.3: no empty panel)
    eway: e && e.is_required ? {
      eway_bill_no: e.eway_bill_no ?? null, date_text: v.eway_bill_datetime_text ?? null, valid_until_text: v.valid_until_text ?? null, expired: v.expired,
      distance_km: e.approx_distance_km == null ? null : n(e.approx_distance_km), transport_mode: e.transport_mode ?? null, transporter_name: e.transporter_name ?? null,
      transporter_gstin: e.transporter_gstin ?? null, vehicle_no: e.eway_vehicle_no ?? null, qr_payload: e.qr_payload ?? null, status: e.status,
    } : null,
    print: { reprint_no: reprintNo, printed_at: istText(new Date()) ?? '', printed_by: printedBy },
  };
}

/**
 * GET /:id/print — the A4 portrait PDF. `purpose=preview` (default) only shows it; `print` / `download` of an
 * approved DC count as a print (the second and later ones are marked "Reprint n" and audited as REPRINT).
 * `download=1` sends it as a file.
 */
yarnIssueDcRouter.get(`${BASE}/:id/print`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId; const uid = req.user!.id;
  const id = idParam(req);
  const q = z.object({ purpose: z.enum(['preview', 'print', 'download']).default('preview'), download: z.coerce.number().int().optional() }).parse(req.query);
  const h = await queryOne<any>('SELECT id, dc_no, doc_status, print_count FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [id, cid]);
  if (!h) throw NotFound('Knitting yarn issue DC not found');
  const counts = h.doc_status === 'APPROVED' && q.purpose !== 'preview';
  let reprintNo = n(h.print_count);
  if (counts) {
    reprintNo += 1;
    await transaction(async (tx) => {
      await txExecute(tx, 'UPDATE trx_knitting_dc SET print_count = print_count + 1, last_printed_at = NOW(), last_printed_by = ? WHERE id = ?', [uid, id]);
      await dcAudit(tx, { cid, dcId: id, dcNo: h.dc_no, action: reprintNo > 1 ? 'REPRINT' : 'PRINT', new: { print_no: reprintNo, purpose: q.purpose }, uid });
    });
  }
  const me = await queryOne<any>('SELECT full_name FROM mst_user WHERE id = ?', [uid]);
  const buf = await renderYarnIssueDcPdf(await pdfData(cid, id, me?.full_name ?? null, counts ? reprintNo : 0));
  const name = `${String(h.dc_no).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${q.download || q.purpose === 'download' ? 'attachment' : 'inline'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
}));

/* ================================================================
   E-WAY BILL (§15–16)
================================================================ */

yarnIssueDcRouter.get(`${BASE}/:id/eway-bill`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dc = await queryOne<any>('SELECT id, doc_status FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [idParam(req), cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const e = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [dc.id]);
  res.json({ success: true, data: ewbView(e, dc.doc_status) });
}));

const ewbIn = z.object({
  is_required: z.coerce.boolean(),
  eway_bill_no: s.nullableStr(20),
  eway_bill_datetime: s.nullableStr(25),
  valid_until: s.nullableStr(25),
  approx_distance_km: z.union([z.coerce.number(), z.literal(''), z.null()]).optional(),
  transport_mode: z.union([z.enum(['Road', 'Rail', 'Air', 'Ship', 'Other']), z.literal(''), z.null()]).optional(),
  transporter_party_id: s.id(),
  transporter_gstin: s.nullableStr(15),
  transporter_name: s.nullableStr(150),
  same_as_dc_vehicle: z.coerce.boolean().default(true),
  eway_vehicle_no: s.nullableStr(30),
  reference_url: s.nullableStr(500),
  remarks: s.nullableStr(500),
  change_reason: s.nullableStr(500),
});

yarnIssueDcRouter.put(`${BASE}/:id/eway-bill`, requireAny('PROCESS.ISSUE', 'EWAY.UPDATE', 'KNIT_DC.EDIT_APPROVED'), ah(async (req, res) => {
  rejectPricing(req.body);
  const cid = req.user!.companyId; const uid = req.user!.id;
  const dc = await queryOne<any>('SELECT * FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [idParam(req), cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const b = ewbIn.parse(req.body);
  assertEwbChangeAllowed(req, dc, b.change_reason);
  const old = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [dc.id]);

  let row: Record<string, unknown>;
  if (!b.is_required) {
    row = { is_required: 0, eway_bill_no: null, eway_bill_datetime: null, valid_until: null, approx_distance_km: null, transport_mode: null, transporter_party_id: null,
      transporter_gstin: null, transporter_name: null, same_as_dc_vehicle: 1, eway_vehicle_no: null, reference_url: null, remarks: b.remarks ?? null,
      source_type: 'MANUAL', linked_ewb_id: null, qr_payload: null, qr_source: null, status: 'NOT_REQUIRED' };
  } else {
    const no = b.eway_bill_no ? b.eway_bill_no.replace(/\s+/g, '') : null;
    // GST portal e-way bill numbers are 12 digits
    if (no && !/^\d{12}$/.test(no)) throw BadRequest('E-way bill number must be the 12-digit number from the GST portal');
    const when = istToUtc(b.eway_bill_datetime);
    const until = istToUtc(b.valid_until);
    const dist = b.approx_distance_km === '' || b.approx_distance_km == null ? null : Number(b.approx_distance_km);
    if (dist != null && (!(dist > 0) || dist > 4000)) throw BadRequest('Approx. distance must be more than 0 and at most 4000 KM');
    if (no) {
      if (!when) throw BadRequest('Enter the e-way bill date and time');
      if (dist == null) throw BadRequest('Enter the approx. distance (KM) of the e-way bill');
      if (!b.transport_mode) throw BadRequest('Select the transport mode');
    }
    if (when && until && until.getTime() <= when.getTime()) throw BadRequest('Valid until must be after the e-way bill date and time');
    let gstin = b.transporter_gstin ? b.transporter_gstin.toUpperCase().replace(/\s+/g, '') : null;
    let tname = b.transporter_name?.trim() || null;
    if (b.transporter_party_id) {
      const t = await queryOne<any>('SELECT id, party_name, gstin, is_transporter FROM mst_party WHERE id = ? AND company_id = ?', [b.transporter_party_id, cid]);
      if (!t) throw BadRequest('Transporter not found');
      gstin = gstin || (t.gstin ? String(t.gstin).toUpperCase() : null);
      tname = tname || t.party_name;
    }
    if (gstin && !validGstin(gstin)) throw BadRequest(`Transporter GSTIN / ID "${gstin}" is not valid (15 characters with a valid check digit)`);
    const veh = b.same_as_dc_vehicle ? vehicle(dc.vehicle_no) : vehicle(b.eway_vehicle_no);
    if (b.reference_url && !/^https?:\/\/\S+$/i.test(b.reference_url)) throw BadRequest('Reference URL must start with http:// or https://');
    // an EWB made through the e-way bill module (same number) is linked; its QR is used only from the official response
    const linked = no ? await queryOne<any>(`SELECT id, status, provider FROM trx_eway_bill WHERE company_id = ? AND ewb_no = ? AND status = 'GENERATED' ORDER BY id DESC LIMIT 1`, [cid, no]) : null;
    const qr = linked ? await verifiedQr(Number(linked.id)) : null;
    if (no) {
      const dup = await queryOne<any>(`SELECT kd.dc_no FROM trx_knitting_dc_eway e JOIN trx_knitting_dc kd ON kd.id = e.dc_id
                                        WHERE e.company_id = ? AND e.eway_bill_no = ? AND e.dc_id <> ? AND e.status <> 'CANCELLED' AND kd.doc_status <> 'CANCELLED' LIMIT 1`, [cid, no, dc.id]);
      if (dup) throw BadRequest(`E-way bill ${no} is already on DC ${dup.dc_no}`);
    }
    row = { is_required: 1, eway_bill_no: no, eway_bill_datetime: when, valid_until: until, approx_distance_km: dist, transport_mode: b.transport_mode || null,
      transporter_party_id: b.transporter_party_id ?? null, transporter_gstin: gstin, transporter_name: tname, same_as_dc_vehicle: b.same_as_dc_vehicle ? 1 : 0,
      eway_vehicle_no: veh, reference_url: b.reference_url ?? null, remarks: b.remarks ?? null,
      source_type: linked ? 'EWB_MODULE' : 'MANUAL', linked_ewb_id: linked?.id ?? null, qr_payload: qr?.payload ?? null, qr_source: qr?.source ?? null,
      status: no ? 'ENTERED' : 'PENDING' };
  }
  const out = await transaction(async (tx) => {
    let ewId: number;
    const cols = Object.keys(row);
    if (old) {
      await txExecute(tx, `UPDATE trx_knitting_dc_eway SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = NOW() WHERE id = ?`, [...cols.map((c) => row[c]), uid, old.id]);
      ewId = Number(old.id);
    } else {
      const r = await txExecute(tx, `INSERT INTO trx_knitting_dc_eway (company_id, dc_id, ${cols.join(', ')}, created_by, updated_by, updated_at) VALUES (?,?,${cols.map(() => '?').join(',')},?,?, NOW())`,
        [cid, dc.id, ...cols.map((c) => row[c]), uid, uid]);
      ewId = Number(r.insertId);
    }
    const strip = (x: any) => (x ? Object.fromEntries(Object.entries(x).filter(([k]) => !['attachment_key', 'qr_payload', 'created_at', 'updated_at', 'created_by', 'updated_by'].includes(k))) : null);
    const after = await txQueryOne<any>(tx, 'SELECT * FROM trx_knitting_dc_eway WHERE id = ?', [ewId]);
    await txExecute(tx, `INSERT INTO trx_knitting_dc_eway_audit (company_id, eway_bill_id, dc_id, action, old_values_json, new_values_json, change_reason, user_id) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, ewId, dc.id, dc.doc_status === 'APPROVED' ? 'UPDATE_AFTER_APPROVAL' : 'SAVE', old ? JSON.stringify(strip(old)) : null, JSON.stringify(strip(after)), b.change_reason ?? null, uid]);
    return after;
  });
  res.json({ success: true, data: ewbView(out, dc.doc_status) });
}));

yarnIssueDcRouter.post(`${BASE}/:id/eway-bill/attachment`, requireAny('PROCESS.ISSUE', 'EWAY.UPDATE', 'KNIT_DC.EDIT_APPROVED'), ah(async (req, res) => {
  const cid = req.user!.companyId; const uid = req.user!.id;
  const dc = await queryOne<any>('SELECT * FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [idParam(req), cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const b = z.object({ filename: z.string().trim().min(1).max(200), data: z.string().min(10), change_reason: s.nullableStr(500) }).parse(req.body);
  assertEwbChangeAllowed(req, dc, b.change_reason);
  const e = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [dc.id]);
  if (!e || !e.is_required) throw BadRequest('Mark "E-way bill required" and save the e-way bill details before attaching its PDF');
  const ext = path.extname(b.filename).toLowerCase();
  const kind = EWB_EXT[ext];
  if (!kind) throw BadRequest('Attach the e-way bill as PDF, PNG or JPG');
  const m = b.data.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  const buf = Buffer.from(m ? m[2] : b.data, 'base64');
  if (!buf.length) throw BadRequest('The file is empty');
  if (buf.length > 10 * 1024 * 1024) throw BadRequest('File is larger than 10 MB');
  if (!kind.magic(buf)) throw BadRequest(`The file content is not a real ${ext.slice(1).toUpperCase()} file`);
  const key = `${cid}/${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.mkdirSync(path.join(EWB_DIR(), String(cid)), { recursive: true });
  fs.writeFileSync(ewbFile(key), buf, { mode: 0o640 });
  const safe = path.basename(b.filename).replace(/[\u0000-\u001f"\\/<>:|?*]/g, '_').slice(0, 200);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  await transaction(async (tx) => {
    await txExecute(tx, `UPDATE trx_knitting_dc_eway SET attachment_key = ?, attachment_name = ?, attachment_mime = ?, attachment_size = ?, attachment_sha256 = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [key, safe, kind.mime, buf.length, sha, uid, e.id]);
    await txExecute(tx, `INSERT INTO trx_knitting_dc_eway_audit (company_id, eway_bill_id, dc_id, action, old_values_json, new_values_json, change_reason, user_id) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, e.id, dc.id, 'ATTACH', JSON.stringify({ attachment_name: e.attachment_name ?? null, attachment_sha256: e.attachment_sha256 ?? null }),
       JSON.stringify({ attachment_name: safe, attachment_sha256: sha, size: buf.length }), b.change_reason ?? null, uid]);
  });
  res.status(201).json({ success: true, data: { attachment_name: safe, attachment_size: buf.length, attachment_mime: kind.mime } });
}));

yarnIssueDcRouter.get(`${BASE}/:id/eway-bill/attachment`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dc = await queryOne<any>('SELECT id FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [idParam(req), cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const e = await queryOne<any>('SELECT attachment_key, attachment_name, attachment_mime FROM trx_knitting_dc_eway WHERE dc_id = ?', [dc.id]);
  if (!e?.attachment_key) throw NotFound('No e-way bill document attached');
  const p = ewbFile(e.attachment_key);
  if (!fs.existsSync(p)) throw NotFound('The attached file is missing on the server');
  res.setHeader('Content-Type', e.attachment_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(e.attachment_name || 'eway-bill').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(p).pipe(res);
}));

yarnIssueDcRouter.delete(`${BASE}/:id/eway-bill/attachment`, requireAny('EWAY.UPDATE', 'KNIT_DC.EDIT_APPROVED', 'PROCESS.ISSUE'), ah(async (req, res) => {
  const cid = req.user!.companyId; const uid = req.user!.id;
  const dc = await queryOne<any>('SELECT * FROM trx_knitting_dc WHERE id = ? AND company_id = ?', [idParam(req), cid]);
  if (!dc) throw NotFound('Knitting yarn issue DC not found');
  const reason = String((req.body as any)?.change_reason ?? req.query.reason ?? '').trim();
  // removing the e-way bill document always needs the right and a reason (spec §15.5)
  if (dc.doc_status === 'APPROVED' || dc.doc_status === 'CANCELLED' || !has(req, 'PROCESS.ISSUE')) {
    if (!has(req, 'KNIT_DC.EDIT_APPROVED') && !has(req, 'EWAY.UPDATE')) throw Forbidden('You are not allowed to remove the e-way bill document');
  }
  if (reason.length < 5) throw BadRequest('Give the reason for removing the e-way bill document (min 5 characters)');
  const e = await queryOne<any>('SELECT * FROM trx_knitting_dc_eway WHERE dc_id = ?', [dc.id]);
  if (!e?.attachment_key) throw NotFound('No e-way bill document attached');
  await transaction(async (tx) => {
    await txExecute(tx, `UPDATE trx_knitting_dc_eway SET attachment_key = NULL, attachment_name = NULL, attachment_mime = NULL, attachment_size = NULL, attachment_sha256 = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`, [uid, e.id]);
    // the file is kept on disk (audit evidence); only the link is removed
    await txExecute(tx, `INSERT INTO trx_knitting_dc_eway_audit (company_id, eway_bill_id, dc_id, action, old_values_json, new_values_json, change_reason, user_id) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, e.id, dc.id, 'REMOVE_ATTACHMENT', JSON.stringify({ attachment_name: e.attachment_name, attachment_sha256: e.attachment_sha256, storage_key: e.attachment_key }), JSON.stringify({ attachment_name: null }), reason, uid]);
  });
  res.json({ success: true, data: { removed: true } });
}));
