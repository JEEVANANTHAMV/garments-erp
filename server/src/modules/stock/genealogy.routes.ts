import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { jobBomRequirement } from '../bom/bom.routes.js';
import { rollTrace, OPEN_ALLOC_SQL } from './jobStock.routes.js';

/**
 * Job material genealogy — the remaining sections of the client document (03-Oct-2026):
 *   §9.2 roll-based process quotation (scan a roll → reverse trace → job / PO / style / buyer / fabric / available)
 *   §18 / §19 a quotation line keeps its rolls; a roll is never over-allocated across live quotations
 *   §17 process quotation costing (process + dye / chemical + other per KG) and approval stamp
 *   §5.1 job material requirement snapshot (planned qty frozen by revision; the BOM is never overwritten)
 *   §5.3 / §6 roll split / merge keeping parent → child genealogy (posted rolls are closed, never deleted)
 *   §21 roll cost carried forward (yarn + knitting + each process, loss uplift) and job standard vs actual cost
 *   §15 /jobs/:id/rolls, /jobs/:id/process-history, /fabric-rolls/:id/genealogy
 *   §22 genealogy reports; §27 clickable job genealogy tree
 */
export const genealogyRouter = Router();
const VIEW = requireAny('PRODUCTION.VIEW', 'QUOTATION.VIEW', 'FABRIC_PROCESS.VIEW', 'INVENTORY.VIEW', 'PURCHASE.VIEW');
const EDIT = requireAny('INVENTORY.CREATE', 'PRODUCTION.CREATE', 'FABRIC_PROCESS.CREATE');
const r3 = (x: unknown) => Math.round((Number(x) || 0) * 1000) / 1000;
const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const n = (v: unknown) => Number(v ?? 0) || 0;
const EPS = 0.0005;
const DEAD_QUOTE = `('REJECTED', 'CANCELLED', 'EXPIRED', 'LOST')`;

// ------------------------------------------------------------------ roll info / eligibility

const ROLL_SQL = (alloc: string) => `
  SELECT fr.id, fr.roll_no, fr.lot_no, fr.fabric_id, fb.fabric_name, fr.process_state, fr.color_name, fr.gsm, fr.dia, fr.fabric_form, fr.weight_kg,
         COALESCE(fr.issued_kg, 0) issued_kg, fr.meters, fr.calc_meters, fr.qc_status, fr.stock_status, fr.so_id, fr.parent_roll_id, fr.source_fpo_id, fr.warehouse_id,
         w.warehouse_name, g.grn_no, g.grn_date, so.so_no, so.io_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, so.buyer_po_no, so.approval_state so_state,
         COALESCE(so.is_deleted, 0) so_deleted, b.party_name buyer_name,
         (SELECT GROUP_CONCAT(DISTINCT st.style_code) FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = so.id) styles,
         (SELECT COALESCE(SUM(ri.weight_kg), 0) FROM trx_fabric_process_roll_in ri WHERE ri.fabric_roll_id = fr.id AND ri.status = 'DRAFT') draft_kg,
         ${alloc} allocated_kg,
         pr.receipt_no production_no, kp.program_no, sfo.fpo_no previous_process, sfo.sub_process previous_process_type
    FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
    LEFT JOIN trx_sales_order so ON so.id = fr.so_id LEFT JOIN mst_party b ON b.id = so.buyer_id
    LEFT JOIN trx_process_receipt pr ON pr.grn_id = fr.grn_id AND pr.src_type = 'KNITTING_PROGRAM' LEFT JOIN trx_knitting_program kp ON kp.id = pr.src_id
    LEFT JOIN trx_fabric_process_order sfo ON sfo.id = fr.source_fpo_id`;

function shapeRoll(r: any) {
  const available = r3(n(r.weight_kg) - n(r.issued_kg) - n(r.draft_kg) - n(r.allocated_kg));
  const mPerKg = n(r.weight_kg) > 0 ? n(r.meters || r.calc_meters) / n(r.weight_kg) : 0;
  return { ...r, available_kg: Math.max(0, available), available_m: r3(Math.max(0, available) * mPerKg), m_per_kg: mPerKg };
}

/** Why a roll cannot go on a process quotation (empty = eligible). `dye` → only grey fabric. */
function rollProblems(r: any, ctx: { dye?: boolean; so_id?: number | null }) {
  const p: string[] = [];
  if (!r.so_id) p.push('the roll is not of any job');
  else if (Number(r.so_deleted) || ['CANCELLED', 'CLOSED'].includes(String(r.so_state ?? ''))) p.push(`job ${r.job_no} is not active`);
  if (ctx.so_id && Number(r.so_id) !== Number(ctx.so_id)) p.push(`the roll belongs to job ${r.job_no ?? '—'}, not the selected job`);
  if (r.qc_status !== 'ACCEPTED') p.push(`QC is ${String(r.qc_status).toLowerCase()}`);
  if (r.stock_status === 'CLOSED') p.push('the roll is closed');
  if (ctx.dye && r.process_state !== 'GREY') p.push(`it is ${String(r.process_state ?? '').toLowerCase()} fabric, dyeing takes grey`);
  if (r.available_kg <= EPS) p.push(n(r.allocated_kg) > EPS ? `its KG is already on another live quotation (${r3(r.allocated_kg)} KG)` : 'no KG available');
  return p;
}

/** GET /fabric-rolls/lookup?roll_no=&process=&so_id=&exclude_quotation_id= — scan a roll for a process quotation (doc §9.2). */
genealogyRouter.get('/fabric-rolls/lookup', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ roll_no: z.string().trim().max(60).optional(), roll_id: z.coerce.number().int().positive().optional(), process: z.string().max(100).optional(),
    so_id: z.coerce.number().int().positive().optional(), exclude_quotation_id: z.coerce.number().int().min(0).optional() }).parse(req.query);
  if (!q.roll_no && !q.roll_id) throw BadRequest('Enter the roll no');
  // roll nos repeat across GRNs (01, 02 …): narrow to the job when given; still several → the caller picks
  const rows = await query<any>(`${ROLL_SQL(OPEN_ALLOC_SQL('fr.id', '?'))} WHERE fr.company_id = ? AND ${q.roll_id ? 'fr.id = ?' : 'fr.roll_no = ?'} ORDER BY fr.id DESC LIMIT 30`,
    [q.exclude_quotation_id ?? 0, cid, q.roll_id ?? q.roll_no]);
  if (!rows.length) throw NotFound(`Roll ${q.roll_no ?? q.roll_id} not found`);
  let cands = rows.map(shapeRoll);
  if (cands.length > 1 && q.so_id) { const mine = cands.filter((c) => Number(c.so_id) === q.so_id); if (mine.length) cands = mine; }
  if (cands.length > 1) { const open = cands.filter((c) => c.stock_status !== 'CLOSED' && c.available_kg > EPS); if (open.length) cands = open; }
  if (cands.length > 1) {
    res.json({ data: { ambiguous: true, roll_no: q.roll_no, candidates: cands.map((c) => ({ id: c.id, roll_no: c.roll_no, job_no: c.job_no, grn_no: c.grn_no, fabric_name: c.fabric_name, process_state: c.process_state, color_name: c.color_name, available_kg: c.available_kg })) } });
    return;
  }
  const r = cands[0];
  const problems = rollProblems(r, { dye: /dye/i.test(q.process ?? ''), so_id: q.so_id ?? null });
  res.json({ data: { ...r, eligible: !problems.length, problems } });
}));

/** GET /fabric-rolls/:id/genealogy — reverse trace (roll → production → program → job → PO / style / buyer) with the roll's cost. */
genealogyRouter.get('/fabric-rolls/:id/genealogy', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const row = await queryOne<any>(`${ROLL_SQL(OPEN_ALLOC_SQL('fr.id', '0'))} WHERE fr.id = ? AND fr.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Roll not found');
  const [trace, cost, history] = await Promise.all([rollTrace(cid, id), rollCost(cid, id), query<any>(
    `SELECT h.event, h.ref_no, h.qty_kg, h.event_time, h.remarks, rr.roll_no related_roll FROM trx_fabric_roll_history h LEFT JOIN trx_fabric_roll rr ON rr.id = h.related_roll_id
      WHERE h.roll_id = ? ORDER BY h.id`, [id])]);
  res.json({ data: { roll: shapeRoll(row), ...trace, cost, history } });
}));

// ------------------------------------------------------------------ quotation rolls (§18 / §19) + costing / approval (§17)

/**
 * After a quotation (and its lines) is written: the rolls of each process line are re-saved and checked —
 * the roll is the line's job's, QC accepted, grey for dyeing, and its KG on this quotation ≤ what is free
 * (weight − issued − on draft DCs − open on other live quotations, + what this quotation already sent);
 * the line qty = its rolls' KG. The process / dye-chemical / other breakup adds up to the line rate.
 * Accepting the quotation stamps approved by / at.
 */
export async function quotationAfterWriteTx(req: Request, row: any, tx: Tx) {
  const cid = req.user!.companyId;
  const qid = Number(row.id);
  const head = await txQueryOne<any>(tx, `SELECT q.quotation_category, q.process_name, q.approved_at, cs.code status FROM trx_quotation q LEFT JOIN cfg_status cs ON cs.id = q.status_id WHERE q.id = ?`, [qid]);
  if (head?.status === 'ACCEPTED' && !head.approved_at) await txExecute(tx, 'UPDATE trx_quotation SET approved_by = ?, approved_at = NOW() WHERE id = ?', [req.user!.id, qid]);
  else if (head && head.status !== 'ACCEPTED' && head.approved_at) await txExecute(tx, 'UPDATE trx_quotation SET approved_by = NULL, approved_at = NULL WHERE id = ?', [qid]);

  const body: any[] | undefined = req.body?.lines;
  if (!Array.isArray(body)) return;
  const saved = await txQuery<any>(tx, 'SELECT id, so_id, fabric_id, qty, unit_price, quotation_rate, process_rate, dye_chem_rate, other_rate FROM trx_quotation_line WHERE quotation_id = ? ORDER BY id', [qid]);
  for (const [i, l] of saved.entries()) {
    const parts = [l.process_rate, l.dye_chem_rate, l.other_rate];
    const quoted = n(l.quotation_rate) || n(l.unit_price);
    if (parts.some((x) => x != null) && Math.abs(parts.reduce((a: number, x) => a + n(x), 0) - quoted) > 0.005) {
      throw BadRequest(`Line ${i + 1}: process + dye / chemical + other (₹${r2(parts.reduce((a: number, x) => a + n(x), 0))}) must equal the quoted rate ₹${quoted}`);
    }
  }
  await txExecute(tx, 'DELETE FROM trx_quotation_roll WHERE quotation_id = ?', [qid]);
  const dye = /dye/i.test(String(head?.process_name ?? ''));
  const seen = new Set<number>();
  for (const [i, raw] of body.entries()) {
    const rolls: any[] = Array.isArray(raw?.rolls) ? raw.rolls : [];
    if (!rolls.length) continue;
    const line = saved[i];
    if (!line) continue;
    if (head?.quotation_category !== 'PROCESS') throw BadRequest('Rolls go only on a process quotation');
    if (!line.so_id) throw BadRequest(`Line ${i + 1}: pick the job — the rolls must belong to it`);
    let total = 0;
    for (const x of rolls) {
      const rollId = Number(x.fabric_roll_id);
      const kg = r3(x.qty_kg);
      if (!(rollId > 0) || !(kg > 0)) throw BadRequest(`Line ${i + 1}: each roll needs its KG`);
      if (seen.has(rollId)) throw BadRequest(`Line ${i + 1}: a roll is on this quotation twice`);
      seen.add(rollId);
      await txQueryOne(tx, 'SELECT id FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [rollId]);
      const rr = await txQueryOne<any>(tx, `${ROLL_SQL(OPEN_ALLOC_SQL('fr.id', '?'))} WHERE fr.id = ? AND fr.company_id = ?`, [qid, rollId, cid]);
      if (!rr) throw BadRequest(`Line ${i + 1}: roll #${rollId} not found`);
      const r = shapeRoll(rr);
      const sentHere = n((await txQueryOne<any>(tx, `SELECT COALESCE(SUM(ri.weight_kg), 0) v FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
          WHERE ri.fabric_roll_id = ? AND o.quotation_id = ? AND o.status <> 'CANCELLED'`, [rollId, qid]))?.v);
      const free = r3(r.available_kg + sentHere);
      const problems = rollProblems({ ...r, available_kg: free }, { dye, so_id: Number(line.so_id) });
      if (problems.length) throw BadRequest(`Line ${i + 1}, roll ${r.roll_no}: ${problems.join('; ')}`);
      if (line.fabric_id && Number(line.fabric_id) !== Number(r.fabric_id)) throw BadRequest(`Line ${i + 1}, roll ${r.roll_no}: it is ${r.fabric_name}, not the line's fabric`);
      if (kg > free + EPS) throw BadRequest(`Line ${i + 1}, roll ${r.roll_no}: ${kg} KG asked, only ${free} KG free`);
      await txExecute(tx, `INSERT INTO trx_quotation_roll (company_id, quotation_id, quotation_line_id, line_sort, fabric_roll_id, so_id, roll_no, qty_kg, qty_m, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [cid, qid, line.id, i, rollId, r.so_id, r.roll_no, kg, x.qty_m != null ? r3(x.qty_m) : r3(kg * r.m_per_kg) || null, req.user!.id]);
      total += kg;
    }
    if (Math.abs(r3(total) - n(line.qty)) > 0.001) throw BadRequest(`Line ${i + 1}: qty ${n(line.qty)} KG must equal its rolls' KG ${r3(total)}`);
  }
}

/** GET /quotations/:id/rolls — the rolls of each line (line_sort = position of the line). */
genealogyRouter.get('/quotations/:id/rolls', VIEW, ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  res.json({ data: await query<any>(
    `SELECT qr.*, fb.fabric_name, fr.process_state, fr.color_name, fr.gsm, fr.dia, fr.lot_no, kp.program_no, pr.receipt_no production_no, sfo.fpo_no previous_process,
            COALESCE((SELECT SUM(ri.weight_kg) FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
                       WHERE ri.fabric_roll_id = qr.fabric_roll_id AND o.quotation_id = qr.quotation_id AND o.status <> 'CANCELLED'), 0) sent_kg
       FROM trx_quotation_roll qr JOIN trx_fabric_roll fr ON fr.id = qr.fabric_roll_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN trx_process_receipt pr ON pr.grn_id = fr.grn_id AND pr.src_type = 'KNITTING_PROGRAM' LEFT JOIN trx_knitting_program kp ON kp.id = pr.src_id
       LEFT JOIN trx_fabric_process_order sfo ON sfo.id = fr.source_fpo_id
      WHERE qr.quotation_id = ? AND qr.company_id = ? ORDER BY qr.line_sort, qr.id`, [id, req.user!.companyId]) });
}));

// ------------------------------------------------------------------ job rolls / process history (§15)

genealogyRouter.get('/jobs/:soId/rolls', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const rows = await query<any>(`${ROLL_SQL(OPEN_ALLOC_SQL('fr.id', '0'))} WHERE fr.company_id = ? AND fr.so_id = ? ORDER BY fr.id`, [cid, soId]);
  res.json({ data: rows.map(shapeRoll) });
}));

genealogyRouter.get('/jobs/:soId/process-history', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const fabric = await query<any>(
    `SELECT o.id, o.fpo_no doc_no, o.fpo_date doc_date, o.sub_process process, o.status, p.party_name vendor, q.quotation_no, o.rate_per_kg,
            COUNT(ri.id) rolls, SUM(ri.weight_kg) input_kg, SUM(ri.good_kg) good_kg, SUM(ri.reject_kg) reject_kg, SUM(ri.loss_kg) loss_kg
       FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id LEFT JOIN mst_party p ON p.id = o.vendor_id LEFT JOIN trx_quotation q ON q.id = o.quotation_id
      WHERE o.company_id = ? AND ri.so_id = ? GROUP BY o.id ORDER BY o.fpo_date, o.id`, [cid, soId]);
  const yarn = await query<any>(
    `SELECT o.id, o.ypo_no doc_no, o.ypo_date doc_date, o.process_code process, o.status, p.party_name vendor, o.rate_per_kg,
            SUM(l.qty_kg) input_kg
       FROM trx_yarn_process_order o JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id LEFT JOIN mst_party p ON p.id = o.vendor_id
      WHERE o.company_id = ? AND l.so_id = ? GROUP BY o.id ORDER BY o.ypo_date, o.id`, [cid, soId]).catch(() => [] as any[]);
  res.json({ data: { fabric: fabric.map((x) => ({ ...x, kind: 'FABRIC' })), yarn: yarn.map((x) => ({ ...x, kind: 'YARN' })) } });
}));

// ------------------------------------------------------------------ requirement snapshot (§5.1)

async function bomLines(cid: number, soId: number) {
  try { return await jobBomRequirement(cid, { so_id: soId }); } catch { return null; }
}

/** Freezes the job's BOM requirement as a new revision; the previous active revision is closed (never overwritten). */
export async function takeRequirementSnapshot(tx: Tx, cid: number, soId: number, userId: number, remarks: string | null) {
  const req = await bomLines(cid, soId);
  if (!req || !req.lines.length) throw BadRequest('The job has no BOM requirement to snapshot — make its BOM first');
  const last = await txQueryOne<any>(tx, 'SELECT COALESCE(MAX(revision_no), 0) r FROM trx_job_material_requirement WHERE company_id = ? AND so_id = ? FOR UPDATE', [cid, soId]);
  const rev = n(last?.r) + 1;
  await txExecute(tx, `UPDATE trx_job_material_requirement SET status = 'CLOSED' WHERE company_id = ? AND so_id = ? AND status = 'ACTIVE'`, [cid, soId]);
  const agg = new Map<string, any>();
  for (const l of req.lines as any[]) {
    const k = `${l.material_type}|${l.yarn_id ?? ''}|${l.fabric_id ?? ''}|${l.trim_id ?? ''}|${l.uom_id ?? ''}`;
    const a = agg.get(k) ?? { ...l, qty: 0, bom_ids: new Set<string>() };
    a.qty += n(l.final_requirement); a.bom_ids.add(String(l.bom_no));
    agg.set(k, a);
  }
  for (const a of agg.values()) {
    await txExecute(tx, `INSERT INTO trx_job_material_requirement (company_id, so_id, revision_no, bom_id, bom_no, material_type, yarn_id, fabric_id, trim_id, material_name, required_qty, uom_id, uom_code, status, remarks, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?)`,
      [cid, soId, rev, a.bom_id ?? null, [...a.bom_ids].join(', '), a.material_type, a.yarn_id ?? null, a.fabric_id ?? null, a.trim_id ?? null, a.material_name ?? null, r3(a.qty), a.uom_id ?? null, a.uom_code ?? null, remarks, userId]);
  }
  return { revision_no: rev, lines: agg.size };
}

/** Snapshot once, when the job's first knitting program is made (doc §7.1 / §29: snapshot before production). Never fails the caller. */
export async function ensureRequirementSnapshot(tx: Tx, cid: number, soId: number | null | undefined, userId: number) {
  if (!soId) return;
  const has = await txQueryOne<any>(tx, 'SELECT id FROM trx_job_material_requirement WHERE company_id = ? AND so_id = ? LIMIT 1', [cid, soId]);
  if (has) return;
  try { await takeRequirementSnapshot(tx, cid, soId, userId, 'Taken with the first knitting program'); } catch { /* no BOM yet — the snapshot is taken later */ }
}

genealogyRouter.get('/jobs/:soId/requirement', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const rows = await query<any>(`SELECT r.*, u.full_name created_by_name FROM trx_job_material_requirement r LEFT JOIN mst_user u ON u.id = r.created_by
     WHERE r.company_id = ? AND r.so_id = ? ORDER BY r.revision_no DESC, r.material_type, r.id`, [cid, soId]);
  res.json({ data: { active: rows.filter((r) => r.status === 'ACTIVE'), revisions: [...new Set(rows.map((r) => r.revision_no))], all: rows } });
}));

genealogyRouter.post('/jobs/:soId/requirement-snapshot', requireAny('BOM.UPDATE', 'BOM.CREATE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const remarks = z.string().trim().max(255).nullish().parse(req.body?.remarks) ?? null;
  const so = await queryOne<any>('SELECT id FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const out = await transaction((tx) => takeRequirementSnapshot(tx, cid, soId, req.user!.id, remarks));
  await audit(req, 'trx_job_material_requirement', soId, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `Requirement snapshot revision ${out.revision_no} saved (${out.lines} materials)` });
}));

// ------------------------------------------------------------------ roll split / merge (§5.3, §6)

const COPY_SKIP = new Set(['id', 'created_at', 'updated_at']);
async function insertRollFrom(tx: Tx, src: any, over: Record<string, unknown>) {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!COPY_SKIP.has(k)) row[k] = v;
  Object.assign(row, over);
  const cols = Object.keys(row);
  const r = await txExecute(tx, `INSERT INTO trx_fabric_roll (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
  return Number(r.insertId);
}
async function uniqueRollNo(tx: Tx, cid: number, base: string) {
  for (let i = 0; i < 50; i++) {
    const cand = i ? `${base}-${i}` : base;
    if (!(await txQueryOne(tx, 'SELECT id FROM trx_fabric_roll WHERE company_id = ? AND roll_no = ? LIMIT 1', [cid, cand]))) return cand;
  }
  throw BadRequest(`Could not make a roll no from ${base}`);
}
const hist = (tx: Tx, req: Request, h: { roll_id: number; roll_no: string; event: string; qty: number; so_id: number | null; related: number; ref_no: string; remarks: string }) =>
  txExecute(tx, `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_no, qty_kg, so_id, related_roll_id, remarks, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [req.user!.companyId, h.roll_id, h.roll_no, h.event, 'ROLL_SPLIT_MERGE', h.ref_no, r3(h.qty), h.so_id, h.related, h.remarks, req.user!.id]);

/** A roll that can be split / merged: QC accepted, open, KG left, not on a draft DC or a live quotation. Locked. */
async function lockedRoll(tx: Tx, cid: number, id: number) {
  const fr = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
  if (!fr) throw BadRequest(`Roll #${id} not found`);
  const info = shapeRoll(await txQueryOne<any>(tx, `${ROLL_SQL(OPEN_ALLOC_SQL('fr.id', '0'))} WHERE fr.id = ?`, [id]));
  if (fr.qc_status !== 'ACCEPTED') throw BadRequest(`${fr.roll_no}: QC is ${String(fr.qc_status).toLowerCase()}`);
  if (fr.stock_status === 'CLOSED') throw BadRequest(`${fr.roll_no} is closed`);
  if (n(info.draft_kg) > EPS) throw BadRequest(`${fr.roll_no} is on a draft process DC — confirm or remove it first`);
  if (n(info.allocated_kg) > EPS) throw BadRequest(`${fr.roll_no} is on a live process quotation (${r3(info.allocated_kg)} KG) — take it off the quotation first`);
  const left = r3(n(fr.weight_kg) - n(fr.issued_kg));
  if (left <= EPS) throw BadRequest(`${fr.roll_no} has no KG left`);
  return { fr, left, mPerKg: n(fr.weight_kg) > 0 ? n(fr.meters || fr.calc_meters) / n(fr.weight_kg) : 0 };
}
const scaleM = (fr: any, kg: number, mPerKg: number) => ({
  meters: fr.meters != null ? r3(kg * mPerKg) : null,
  ...('calc_meters' in fr ? { calc_meters: fr.calc_meters != null && n(fr.weight_kg) > 0 ? r3(n(fr.calc_meters) * kg / n(fr.weight_kg)) : null } : {}),
  ...('actual_meters' in fr ? { actual_meters: fr.actual_meters != null && n(fr.weight_kg) > 0 ? r3(n(fr.actual_meters) * kg / n(fr.weight_kg)) : null } : {}),
});
const closeRoll = (tx: Tx, fr: any, note: string) =>
  txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = weight_kg, stock_status = 'CLOSED', remarks = LEFT(CONCAT(COALESCE(remarks, ''), ?), 255) WHERE id = ?`, [` ${note}`, fr.id]);

/** POST /fabric-rolls/:id/split { parts: [kg, …], reason } — the KG left on the roll into 2+ child rolls (parent closed, genealogy kept). */
genealogyRouter.post('/fabric-rolls/:id/split', EDIT, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({ parts: z.array(z.coerce.number().positive()).min(2, 'Split into at least two rolls').max(20), reason: z.string().trim().min(3, 'Give the reason').max(200) }).parse(req.body);
  const out = await transaction(async (tx) => {
    const { fr, left, mPerKg } = await lockedRoll(tx, cid, id);
    const sum = r3(b.parts.reduce((a, x) => a + x, 0));
    if (Math.abs(sum - left) > 0.001) throw BadRequest(`${fr.roll_no}: the parts (${sum} KG) must add up to the KG left on the roll (${left} KG)`);
    const children: { id: number; roll_no: string; weight_kg: number }[] = [];
    for (const [i, kg] of b.parts.entries()) {
      const no = await uniqueRollNo(tx, cid, `${fr.roll_no}-S${i + 1}`);
      const cidRoll = await insertRollFrom(tx, fr, { roll_no: no, weight_kg: r3(kg), issued_kg: 0, stock_status: 'AVAILABLE', parent_roll_id: fr.id, ...scaleM(fr, kg, mPerKg),
        remarks: `Split from ${fr.roll_no}: ${b.reason}`.slice(0, 255) });
      children.push({ id: cidRoll, roll_no: no, weight_kg: r3(kg) });
      await hist(tx, req, { roll_id: fr.id, roll_no: fr.roll_no, event: 'SPLIT', qty: kg, so_id: fr.so_id, related: cidRoll, ref_no: no, remarks: b.reason });
      await hist(tx, req, { roll_id: cidRoll, roll_no: no, event: 'SPLIT_FROM', qty: kg, so_id: fr.so_id, related: fr.id, ref_no: fr.roll_no, remarks: b.reason });
    }
    await closeRoll(tx, fr, `Split into ${children.map((c) => c.roll_no).join(', ')}`);
    return { roll_no: fr.roll_no, children };
  });
  await audit(req, 'trx_fabric_roll', id, 'UPDATE', undefined, { action: 'SPLIT', ...out, reason: b.reason });
  res.status(201).json({ data: out, message: `${out.roll_no} split into ${out.children.map((c) => `${c.roll_no} (${c.weight_kg} KG)`).join(', ')}` });
}));

/** POST /fabric-rolls/merge { roll_ids, reason } — rolls of the same job / fabric / state / colour / GSM / Dia / store into one roll. */
genealogyRouter.post('/fabric-rolls/merge', EDIT, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ roll_ids: z.array(z.coerce.number().int().positive()).min(2, 'Pick at least two rolls').max(30), reason: z.string().trim().min(3, 'Give the reason').max(200) }).parse(req.body);
  if (new Set(b.roll_ids).size !== b.roll_ids.length) throw BadRequest('A roll is picked twice');
  const out = await transaction(async (tx) => {
    const src: Awaited<ReturnType<typeof lockedRoll>>[] = [];
    for (const id of [...b.roll_ids].sort((a, c) => a - c)) src.push(await lockedRoll(tx, cid, id));
    const f = src[0].fr;
    const same = (k: string) => src.every((s) => String(s.fr[k] ?? '') === String(f[k] ?? ''));
    for (const [k, label] of [['so_id', 'job'], ['fabric_id', 'fabric'], ['process_state', 'process state'], ['color_name', 'colour'], ['gsm', 'GSM'], ['dia', 'Dia'], ['warehouse_id', 'store']] as const) {
      if (!same(k)) throw BadRequest(`Only rolls of the same ${label} can be merged`);
    }
    const kg = r3(src.reduce((a, s) => a + s.left, 0));
    const m = src.reduce((a, s) => a + s.left * s.mPerKg, 0);
    const no = await uniqueRollNo(tx, cid, `${f.roll_no}-M`);
    const newId = await insertRollFrom(tx, f, { roll_no: no, weight_kg: kg, issued_kg: 0, stock_status: 'AVAILABLE', parent_roll_id: f.id, ...scaleM(f, kg, kg > 0 ? m / kg : 0),
      lot_no: same('lot_no') ? f.lot_no : [...new Set(src.map((s) => s.fr.lot_no).filter(Boolean))].join('/').slice(0, 60) || null,
      remarks: `Merged from ${src.map((s) => s.fr.roll_no).join(', ')}: ${b.reason}`.slice(0, 255) });
    for (const s of src) {
      await hist(tx, req, { roll_id: s.fr.id, roll_no: s.fr.roll_no, event: 'MERGE', qty: s.left, so_id: s.fr.so_id, related: newId, ref_no: no, remarks: b.reason });
      await hist(tx, req, { roll_id: newId, roll_no: no, event: 'MERGED_FROM', qty: s.left, so_id: s.fr.so_id, related: s.fr.id, ref_no: s.fr.roll_no, remarks: b.reason });
      await closeRoll(tx, s.fr, `Merged into ${no}`);
    }
    return { roll_no: no, id: newId, weight_kg: kg, from: src.map((s) => s.fr.roll_no) };
  });
  await audit(req, 'trx_fabric_roll', out.id, 'INSERT', undefined, { action: 'MERGE', ...out, reason: b.reason });
  res.status(201).json({ data: out, message: `${out.from.join(', ')} merged into ${out.roll_no} (${out.weight_kg} KG)` });
}));

// ------------------------------------------------------------------ costing (§21)

/**
 * Cost per KG a roll carries: purchased fabric = its GRN rate; knitted = yarn cost (issued lots × lot rate ÷ the
 * program's fabric output, so knitting loss is carried) + the knitting job-work rate; a process output = the input
 * roll's cost × input / output KG (process loss) + the process rate; a split child = its parent; a merged roll =
 * the KG-weighted cost of its sources. Standard (BOM) cost stays separate (job cost).
 */
export async function rollCost(cid: number, rollId: number, memo = new Map<number, any>(), depth = 0): Promise<{ cost_per_kg: number; steps: any[] }> {
  if (memo.has(rollId)) return memo.get(rollId);
  if (depth > 15) return { cost_per_kg: 0, steps: [{ stage: 'Depth limit', rate: 0 }] };
  const r = await queryOne<any>(
    `SELECT fr.id, fr.roll_no, fr.weight_kg, fr.parent_roll_id, fr.source_fpo_id, fr.grn_id, gl.rate grn_rate, g.grn_no, pr.src_type, pr.src_id,
            (SELECT p.source_fpo_id FROM trx_fabric_roll p WHERE p.id = fr.parent_roll_id) parent_fpo, o.fpo_no, o.sub_process
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_process_receipt pr ON pr.grn_id = fr.grn_id AND pr.src_type = 'KNITTING_PROGRAM' LEFT JOIN trx_fabric_process_order o ON o.id = fr.source_fpo_id
      WHERE fr.id = ? AND fr.company_id = ?`, [rollId, cid]);
  let out: { cost_per_kg: number; steps: any[] };
  if (!r) out = { cost_per_kg: 0, steps: [] };
  else {
    const merged = await query<any>(`SELECT related_roll_id id, qty_kg FROM trx_fabric_roll_history WHERE roll_id = ? AND event = 'MERGED_FROM'`, [rollId]);
    const processStep = r.source_fpo_id && Number(r.source_fpo_id) !== Number(r.parent_fpo ?? 0);
    if (merged.length) {
      let v = 0, kg = 0;
      for (const m of merged) { const c = await rollCost(cid, Number(m.id), memo, depth + 1); v += c.cost_per_kg * n(m.qty_kg); kg += n(m.qty_kg); }
      out = { cost_per_kg: kg > 0 ? v / kg : 0, steps: [{ stage: 'Merged', ref: r.roll_no, note: `${merged.length} rolls, KG-weighted`, rate: kg > 0 ? r2(v / kg) : 0 }] };
    } else if (processStep) {
      // input: the parent roll, else the rolls that went out on the DC
      let inCost = 0;
      if (r.parent_roll_id) inCost = (await rollCost(cid, Number(r.parent_roll_id), memo, depth + 1)).cost_per_kg;
      else {
        const ins = await query<any>('SELECT fabric_roll_id id, weight_kg FROM trx_fabric_process_roll_in WHERE fpo_id = ? AND fabric_roll_id IS NOT NULL', [r.source_fpo_id]);
        let v = 0, kg = 0;
        for (const x of ins) { const c = await rollCost(cid, Number(x.id), memo, depth + 1); v += c.cost_per_kg * n(x.weight_kg); kg += n(x.weight_kg); }
        inCost = kg > 0 ? v / kg : 0;
      }
      const ro = await queryOne<any>('SELECT input_kg, weight_kg FROM trx_fabric_process_roll_out WHERE fabric_roll_id = ? LIMIT 1', [rollId]);
      const uplift = ro && n(ro.weight_kg) > 0 && n(ro.input_kg) > 0 ? n(ro.input_kg) / n(ro.weight_kg) : 1;
      const rate = n(r.grn_rate);
      const prev = r.parent_roll_id ? memo.get(Number(r.parent_roll_id)) : null;
      out = { cost_per_kg: inCost * uplift + rate, steps: [...(prev?.steps ?? []), { stage: r.sub_process ?? 'Process', ref: r.fpo_no, note: uplift > 1.0001 ? `input carried × ${r3(uplift)} for process loss` : '', rate: r2(rate) }] };
    } else if (r.parent_roll_id) {
      const c = await rollCost(cid, Number(r.parent_roll_id), memo, depth + 1);
      out = { cost_per_kg: c.cost_per_kg, steps: c.steps };
    } else if (r.src_type === 'KNITTING_PROGRAM' && r.src_id) {
      const y = await queryOne<any>(`SELECT COALESCE(SUM(pi.issued_qty_kg * COALESCE(gl.rate, 0)), 0) v, COALESCE(SUM(pi.issued_qty_kg), 0) kg
          FROM trx_process_issue pi LEFT JOIN trx_grn_line gl ON gl.id = pi.grn_line_id WHERE pi.src_type = 'KNITTING_PROGRAM' AND pi.src_id = ?`, [r.src_id]);
      const out_kg = n((await queryOne<any>(`SELECT COALESCE(SUM(output_qty), 0) v FROM trx_process_receipt WHERE src_type = 'KNITTING_PROGRAM' AND src_id = ?`, [r.src_id]))?.v);
      const yarnPerKg = out_kg > 0 ? n(y?.v) / out_kg : 0;
      out = { cost_per_kg: yarnPerKg + n(r.grn_rate), steps: [
        { stage: 'Yarn', ref: `${r3(y?.kg)} KG issued`, note: out_kg > 0 ? `₹${r2(y?.v)} ÷ ${r3(out_kg)} KG fabric (knitting loss carried)` : 'no fabric output yet', rate: r2(yarnPerKg) },
        { stage: 'Knitting', ref: r.grn_no, note: 'job-work rate', rate: r2(r.grn_rate) }] };
    } else {
      out = { cost_per_kg: n(r.grn_rate), steps: [{ stage: 'Purchased fabric', ref: r.grn_no, note: 'GRN rate', rate: r2(r.grn_rate) }] };
    }
  }
  out = { cost_per_kg: r2(out.cost_per_kg), steps: out.steps };
  memo.set(rollId, out);
  return out;
}

genealogyRouter.get('/fabric-rolls/:id/cost', VIEW, ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const roll = await queryOne<any>('SELECT id, roll_no, weight_kg, COALESCE(issued_kg, 0) issued_kg FROM trx_fabric_roll WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!roll) throw NotFound('Roll not found');
  const c = await rollCost(req.user!.companyId, id);
  res.json({ data: { ...roll, ...c, value: r2(c.cost_per_kg * (n(roll.weight_kg) - n(roll.issued_kg))) } });
}));

/** Job standard (BOM) cost vs actual cost — kept separate (doc §21). */
export async function jobCost(cid: number, soId: number) {
  const req = await bomLines(cid, soId);
  const std = new Map<string, number>();
  for (const l of (req?.lines ?? []) as any[]) std.set(l.material_type, r2((std.get(l.material_type) ?? 0) + n(l.estimated_amount)));
  const v = async (sql: string, p: unknown[]) => n((await queryOne<any>(sql, p))?.v);
  const yarn = await v(`SELECT COALESCE(SUM(gl.accepted_qty * gl.rate), 0) v FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
     WHERE g.company_id = ? AND gl.so_id = ? AND gl.material_type = 'YARN' AND COALESCE(gl.po_id, g.po_id) IS NOT NULL`, [cid, soId]);
  const fabric = await v(`SELECT COALESCE(SUM(gl.accepted_qty * gl.rate), 0) v FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
     WHERE g.company_id = ? AND gl.so_id = ? AND gl.material_type = 'FABRIC' AND COALESCE(gl.po_id, g.po_id) IS NOT NULL`, [cid, soId]);
  const knitting = await v(`SELECT COALESCE(SUM(gl.accepted_qty * gl.rate), 0) v FROM trx_process_receipt pr JOIN trx_knitting_program kp ON kp.id = pr.src_id
       JOIN trx_grn_line gl ON gl.grn_id = pr.grn_id WHERE pr.company_id = ? AND pr.src_type = 'KNITTING_PROGRAM' AND kp.so_id = ?`, [cid, soId]);
  const processes = await query<any>(`SELECT o.sub_process process, COALESCE(SUM(ro.weight_kg * COALESCE(o.rate_per_kg, 0)), 0) amount, COALESCE(SUM(ro.weight_kg), 0) kg
       FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_order o ON o.id = ro.fpo_id WHERE o.company_id = ? AND ro.so_id = ? AND o.status <> 'CANCELLED' GROUP BY o.sub_process`, [cid, soId]);
  const trims = await v(`SELECT COALESCE(SUM(tl.accepted_qty * tl.rate), 0) v FROM trx_trim_grn_line tl JOIN trx_trim_grn t ON t.id = tl.grn_id WHERE t.company_id = ? AND tl.so_id = ?`, [cid, soId]).catch(() => 0);
  const actual = [
    { head: 'Yarn purchased', amount: r2(yarn) }, { head: 'Fabric purchased', amount: r2(fabric) }, { head: 'Knitting (job work)', amount: r2(knitting) },
    ...processes.map((p) => ({ head: `Process — ${p.process}`, amount: r2(p.amount), kg: r3(p.kg) })), { head: 'Trims', amount: r2(trims) },
  ];
  const standard = [...std.entries()].map(([k, a]) => ({ head: k, amount: a }));
  return { standard, standard_total: r2(standard.reduce((a, x) => a + x.amount, 0)), actual, actual_total: r2(actual.reduce((a, x) => a + x.amount, 0)), has_bom: !!req };
}

genealogyRouter.get('/jobs/:soId/cost', VIEW, ah(async (req, res) => {
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  res.json({ data: await jobCost(req.user!.companyId, soId) });
}));

// ------------------------------------------------------------------ genealogy tree (§27)

type Node = { key: string; label: string; sub?: string; link?: string; roll_id?: number; kind: string; children?: Node[] };

genealogyRouter.get('/jobs/:soId/genealogy-tree', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>(`SELECT so.id, so.so_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, so.buyer_po_no, b.party_name buyer,
      (SELECT GROUP_CONCAT(DISTINCT st.style_code) FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = so.id) styles
     FROM trx_sales_order so LEFT JOIN mst_party b ON b.id = so.buyer_id WHERE so.id = ? AND so.company_id = ?`, [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const kg = (x: unknown) => `${r3(x)} KG`;
  const req2 = await bomLines(cid, soId);
  const snap = await query<any>(`SELECT revision_no, material_name, required_qty, uom_code FROM trx_job_material_requirement WHERE company_id = ? AND so_id = ? AND status = 'ACTIVE'`, [cid, soId]);
  const bomNode: Node = { key: 'bom', kind: 'BOM', label: req2 ? `BOM ${(req2.boms as any[]).map((b2) => b2.bom_no).join(', ')}` : 'No BOM', link: req2?.boms?.[0]?.id ? `/masters/boms/${req2.boms[0].id}` : undefined,
    children: [
      ...((req2?.yarns ?? []) as any[]).map((y, i) => ({ key: `req-${i}`, kind: 'REQ', label: `${y.material_name}`, sub: `planned ${r3(y.final_requirement)} ${y.uom_code ?? 'KG'}` })),
      ...(snap.length ? [{ key: 'snap', kind: 'SNAPSHOT', label: `Requirement snapshot rev ${snap[0].revision_no}`, sub: snap.map((s2) => `${s2.material_name} ${r3(s2.required_qty)} ${s2.uom_code ?? ''}`).join(' · ') }] : []),
    ] };
  const grns = await query<any>(`SELECT g.id, g.grn_no, g.grn_date, po.po_no, gl.lot_no, y.yarn_name, gl.accepted_qty FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
      LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
     WHERE g.company_id = ? AND gl.so_id = ? AND gl.material_type = 'YARN' AND COALESCE(gl.po_id, g.po_id) IS NOT NULL ORDER BY g.grn_date, g.id`, [cid, soId]);
  const yarnNode: Node = { key: 'yarn', kind: 'GROUP', label: `Yarn purchase / GRN (${grns.length})`, children: grns.map((g) => ({ key: `grn-${g.id}-${g.lot_no}`, kind: 'GRN',
    label: `${g.grn_no} · lot ${g.lot_no ?? '—'}`, sub: `${g.yarn_name ?? ''} · ${kg(g.accepted_qty)}${g.po_no ? ` · PO ${g.po_no}` : ''}`, link: `/procurement/yarn/grn/${g.id}` })) };
  const progs = await query<any>(`SELECT id, program_no, fabric_type, required_qty_kg, status FROM trx_knitting_program WHERE company_id = ? AND (so_id = ? OR io_no = ?) AND status <> 'CANCELLED' ORDER BY id`, [cid, soId, so.job_no]);
  const rollNode = (r: any): Node => ({ key: `roll-${r.id}`, kind: 'ROLL', roll_id: Number(r.id), label: r.roll_no,
    sub: `${r.process_state ?? ''}${r.color_name ? ` ${r.color_name}` : ''} · ${kg(r.weight_kg)}${r.stock_status === 'CLOSED' ? ' · closed' : ` · ${kg(n(r.weight_kg) - n(r.issued_kg))} left`}` });
  const progNodes: Node[] = [];
  for (const p of progs) {
    const dcs = await query<any>(`SELECT dc_no, SUM(issued_qty_kg) kg FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ? AND dc_no IS NOT NULL GROUP BY dc_no`, [cid, p.id]);
    const recs = await query<any>(`SELECT pr.id, pr.receipt_no, pr.grn_id, pr.output_qty FROM trx_process_receipt pr WHERE pr.company_id = ? AND pr.src_type = 'KNITTING_PROGRAM' AND pr.src_id = ? ORDER BY pr.id`, [cid, p.id]);
    const recNodes: Node[] = [];
    for (const rc of recs) {
      const rolls = await query<any>('SELECT id, roll_no, process_state, color_name, weight_kg, issued_kg, stock_status FROM trx_fabric_roll WHERE grn_id = ? ORDER BY id', [rc.grn_id]);
      recNodes.push({ key: `rec-${rc.id}`, kind: 'PRODUCTION', label: `Production ${rc.receipt_no}`, sub: kg(rc.output_qty), children: rolls.map(rollNode) });
    }
    progNodes.push({ key: `prog-${p.id}`, kind: 'PROGRAM', label: `Knitting program ${p.program_no}`, sub: `${p.fabric_type ?? ''} · ${kg(p.required_qty_kg)} · ${p.status}`, link: '/production/knitting-programs',
      children: [...dcs.map((d) => ({ key: `dc-${p.id}-${d.dc_no}`, kind: 'DC', label: `Yarn outward ${d.dc_no}`, sub: kg(d.kg) })), ...recNodes] });
  }
  const fpos = await query<any>(`SELECT o.id, o.fpo_no, o.sub_process, o.status, SUM(ri.weight_kg) kg FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
     WHERE o.company_id = ? AND ri.so_id = ? GROUP BY o.id ORDER BY o.id`, [cid, soId]);
  const procNodes: Node[] = [];
  for (const o of fpos) {
    const ins = await query<any>(`SELECT fr.id, fr.roll_no, fr.process_state, fr.color_name, ri.weight_kg, fr.issued_kg, fr.stock_status FROM trx_fabric_process_roll_in ri JOIN trx_fabric_roll fr ON fr.id = ri.fabric_roll_id WHERE ri.fpo_id = ? AND ri.so_id = ?`, [o.id, soId]);
    const outs = await query<any>(`SELECT id, roll_no, process_state, color_name, weight_kg, issued_kg, stock_status FROM trx_fabric_roll WHERE source_fpo_id = ? AND so_id = ? ORDER BY id`, [o.id, soId]);
    procNodes.push({ key: `fpo-${o.id}`, kind: 'PROCESS', label: `${o.sub_process} ${o.fpo_no}`, sub: `${kg(o.kg)} sent · ${o.status}`, link: `/production/fabric-process/outward?id=${o.id}`,
      children: [{ key: `fpo-in-${o.id}`, kind: 'GROUP', label: `Input rolls (${ins.length})`, children: ins.map(rollNode) }, { key: `fpo-out-${o.id}`, kind: 'GROUP', label: `Output rolls (${outs.length})`, children: outs.map(rollNode) }] });
  }
  const tree: Node = { key: 'job', kind: 'JOB', label: `Job ${so.job_no}`, sub: [so.buyer, so.buyer_po_no ? `PO ${so.buyer_po_no}` : null, so.styles].filter(Boolean).join(' · '),
    children: [bomNode, yarnNode, { key: 'knit', kind: 'GROUP', label: `Knitting (${progs.length} programs)`, children: progNodes }, { key: 'proc', kind: 'GROUP', label: `Processes (${fpos.length})`, children: procNodes }] };
  res.json({ data: tree });
}));

// ------------------------------------------------------------------ reports (§22)

const REPORTS: Record<string, (cid: number, f: { so_id?: number; vendor_id?: number; from?: string; to?: string; roll_no?: string }) => Promise<any[]>> = {
  /** Job-wise fabric availability: what each job holds now, by fabric / state / colour. */
  'job-fabric-availability': async (cid, f) => query<any>(
    `SELECT COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, fb.fabric_name, fr.process_state, COALESCE(fr.color_name, '') colour, fr.gsm, fr.dia, COUNT(*) rolls,
            ROUND(SUM(fr.weight_kg - COALESCE(fr.issued_kg, 0)), 3) available_kg,
            ROUND(SUM(${OPEN_ALLOC_SQL('fr.id', '0')}), 3) on_quotation_kg
       FROM trx_fabric_roll fr JOIN trx_sales_order so ON so.id = fr.so_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
      WHERE fr.company_id = ? AND fr.qc_status = 'ACCEPTED' AND fr.stock_status <> 'CLOSED' AND fr.weight_kg - COALESCE(fr.issued_kg, 0) > 0.0005 ${f.so_id ? 'AND fr.so_id = ?' : ''}
      GROUP BY so.id, fr.fabric_id, fr.process_state, fr.color_name, fr.gsm, fr.dia ORDER BY job_no, fb.fabric_name`, [cid, ...(f.so_id ? [f.so_id] : [])]),

  /** BOM vs actual yarn: planned (snapshot, else BOM) vs purchased vs issued to knitting, per job and yarn. */
  'bom-vs-actual-yarn': async (cid, f) => {
    const jobs = await query<any>(`SELECT id, COALESCE(NULLIF(io_no, ''), so_no) job_no FROM trx_sales_order WHERE company_id = ? AND is_deleted = 0 ${f.so_id ? 'AND id = ?' : ''} ORDER BY id DESC LIMIT 200`, [cid, ...(f.so_id ? [f.so_id] : [])]);
    const out: any[] = [];
    for (const j of jobs) {
      const snap = await query<any>(`SELECT yarn_id, material_name, required_qty FROM trx_job_material_requirement WHERE company_id = ? AND so_id = ? AND status = 'ACTIVE' AND material_type = 'YARN'`, [cid, j.id]);
      const planned = snap.length ? snap.map((s2) => ({ yarn_id: s2.yarn_id, name: s2.material_name, qty: n(s2.required_qty), src: `snapshot` }))
        : ((await bomLines(cid, j.id))?.yarns ?? []).map((y: any) => ({ yarn_id: y.yarn_id, name: y.material_name, qty: n(y.final_requirement), src: 'BOM' }));
      const bought = await query<any>(`SELECT gl.yarn_id, y.yarn_name name, SUM(gl.accepted_qty) qty FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
          WHERE g.company_id = ? AND gl.so_id = ? AND gl.material_type = 'YARN' AND COALESCE(gl.po_id, g.po_id) IS NOT NULL GROUP BY gl.yarn_id`, [cid, j.id]);
      const issued = await query<any>(`SELECT pi.yarn_id, y.yarn_name name, SUM(pi.issued_qty_kg) qty FROM trx_process_issue pi LEFT JOIN mst_yarn y ON y.id = pi.yarn_id
          WHERE pi.company_id = ? AND pi.so_id = ? AND pi.src_type = 'KNITTING_PROGRAM' GROUP BY pi.yarn_id`, [cid, j.id]);
      const ids = new Set([...planned, ...bought, ...issued].map((x: any) => Number(x.yarn_id)).filter(Boolean));
      for (const id of ids) {
        const p = planned.filter((x: any) => Number(x.yarn_id) === id); const b2 = bought.find((x) => Number(x.yarn_id) === id); const i2 = issued.find((x) => Number(x.yarn_id) === id);
        const pq = r3(p.reduce((a: number, x: any) => a + x.qty, 0));
        out.push({ job_no: j.job_no, yarn: p[0]?.name ?? b2?.name ?? i2?.name, planned_kg: pq, plan_source: p[0]?.src ?? '—', purchased_kg: r3(b2?.qty), issued_kg: r3(i2?.qty),
          variance_kg: r3(n(i2?.qty) - pq), variance_pct: pq > 0 ? r2((n(i2?.qty) - pq) / pq * 100) : null });
      }
    }
    return out;
  },

  /** Yarn input vs fabric output per knitting program (never assumed equal — doc §7.5). */
  'yarn-input-fabric-output': async (cid, f) => query<any>(
    `SELECT kp.program_no, COALESCE(so.io_no, so.so_no, kp.io_no) job_no, kp.fabric_type, p.party_name knitter,
            (SELECT COALESCE(SUM(pi.issued_qty_kg), 0) FROM trx_process_issue pi WHERE pi.src_type = 'KNITTING_PROGRAM' AND pi.src_id = kp.id) yarn_issued_kg,
            COALESCE(SUM(pr.input_qty), 0) yarn_consumed_kg, COALESCE(SUM(pr.output_qty), 0) fabric_good_kg, COALESCE(SUM(pr.rejected_qty), 0) fabric_reject_kg,
            COALESCE(SUM(pr.loss_qty), 0) loss_kg, IF(SUM(pr.input_qty) > 0, ROUND(SUM(pr.output_qty) / SUM(pr.input_qty) * 100, 2), NULL) yield_pct
       FROM trx_knitting_program kp LEFT JOIN trx_sales_order so ON so.id = kp.so_id LEFT JOIN mst_party p ON p.id = kp.vendor_id
       LEFT JOIN trx_process_receipt pr ON pr.src_type = 'KNITTING_PROGRAM' AND pr.src_id = kp.id
      WHERE kp.company_id = ? AND kp.status <> 'CANCELLED' ${f.so_id ? 'AND kp.so_id = ?' : ''}
      GROUP BY kp.id ORDER BY kp.id DESC LIMIT 500`, [cid, ...(f.so_id ? [f.so_id] : [])]),

  /** Fabric roll stock ledger: in / out / balance per roll (job or roll filter required). */
  'roll-ledger': async (cid, f) => {
    if (!f.so_id && !f.roll_no) throw BadRequest('Pick a job or enter a roll no for the roll ledger');
    const rolls = await query<any>(`SELECT fr.id, fr.roll_no, fr.weight_kg, COALESCE(fr.issued_kg, 0) issued_kg, g.grn_no, g.grn_date, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no,
        fr.process_state, (SELECT h.event FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id AND h.event IN ('SPLIT_FROM', 'MERGED_FROM') LIMIT 1) born
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN trx_sales_order so ON so.id = fr.so_id
      WHERE fr.company_id = ? ${f.so_id ? 'AND fr.so_id = ?' : ''} ${f.roll_no ? 'AND fr.roll_no = ?' : ''} ORDER BY fr.id LIMIT 300`,
      [cid, ...(f.so_id ? [f.so_id] : []), ...(f.roll_no ? [f.roll_no] : [])]);
    const out: any[] = [];
    for (const r of rolls) {
      const ev: any[] = [{ date: r.grn_date, ref: r.born ? (r.born === 'SPLIT_FROM' ? 'Split' : 'Merge') : r.grn_no, in_kg: n(r.weight_kg), out_kg: 0, movement: r.born ? 'Created by split / merge' : 'Received' }];
      const pushQ = async (sql: string, p: unknown[], kind: 'in' | 'out', label: string) => {
        for (const x of await query<any>(sql, p)) ev.push({ date: x.d, ref: x.ref, in_kg: kind === 'in' ? n(x.kg) : 0, out_kg: kind === 'out' ? n(x.kg) : 0, movement: label });
      };
      await pushQ(`SELECT o.fpo_date d, o.fpo_no ref, ri.weight_kg kg FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
          WHERE ri.fabric_roll_id = ? AND ri.status <> 'DRAFT' AND o.status NOT IN ('DRAFT', 'CANCELLED')`, [r.id], 'out', 'Process outward');
      await pushQ(`SELECT fi.issue_date d, fi.issue_no ref, fir.issue_kg kg FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id WHERE fir.fabric_roll_id = ?`, [r.id], 'out', 'Issued to cutting');
      await pushQ(`SELECT fr2.return_date d, fr2.return_no ref, fr2.return_kg kg FROM trx_fabric_return fr2 WHERE fr2.fabric_roll_id = ?`, [r.id], 'in', 'Returned from cutting');
      await pushQ(`SELECT pr.return_date d, pr.return_no ref, l.qty_kg kg FROM trx_fabric_process_return_line l JOIN trx_fabric_process_return pr ON pr.id = l.return_id
          WHERE l.source_roll_id = ? AND COALESCE(pr.status, '') <> 'CANCELLED'`, [r.id], 'out', 'Returned to process unit');
      await pushQ(`SELECT t.transfer_date d, t.transfer_no ref, l.qty kg FROM trx_job_transfer_line l JOIN trx_job_transfer t ON t.id = l.transfer_id WHERE l.fabric_roll_id = ?`, [r.id], 'out', 'Job transfer');
      await pushQ(`SELECT DATE(h.event_time) d, h.ref_no ref, h.qty_kg kg FROM trx_fabric_roll_history h WHERE h.roll_id = ? AND h.event IN ('SPLIT', 'MERGE')`, [r.id], 'out', 'Split / merge');
      ev.sort((a, b2) => String(a.date).localeCompare(String(b2.date)));
      let bal = 0;
      for (const e of ev) { bal = r3(bal + e.in_kg - e.out_kg); out.push({ roll_no: r.roll_no, job_no: r.job_no, state: r.process_state, date: e.date, ref: e.ref, movement: e.movement, in_kg: r3(e.in_kg), out_kg: r3(e.out_kg), balance_kg: bal }); }
      const book = r3(n(r.weight_kg) - n(r.issued_kg));
      if (Math.abs(book - bal) > 0.001) out.push({ roll_no: r.roll_no, job_no: r.job_no, movement: `⚠ book balance ${book} KG differs from ledger ${bal} KG`, balance_kg: book });
    }
    return out;
  },

  /** Job-wise process cost: per job and process — KG, rate, value, billed. */
  'job-process-cost': async (cid, f) => query<any>(
    `SELECT COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, o.sub_process process, COUNT(DISTINCT o.id) dcs, ROUND(SUM(ro.input_kg), 3) input_kg, ROUND(SUM(ro.weight_kg), 3) good_kg,
            ROUND(SUM(ro.weight_kg * COALESCE(o.rate_per_kg, 0)) / NULLIF(SUM(ro.weight_kg), 0), 2) avg_rate, ROUND(SUM(ro.weight_kg * COALESCE(o.rate_per_kg, 0)), 2) amount,
            ROUND(SUM(ro.weight_kg * COALESCE(o.rate_per_kg, 0)) / NULLIF(SUM(ro.input_kg), 0), 2) cost_per_input_kg
       FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_order o ON o.id = ro.fpo_id JOIN trx_sales_order so ON so.id = ro.so_id
      WHERE o.company_id = ? AND o.status <> 'CANCELLED' ${f.so_id ? 'AND ro.so_id = ?' : ''} ${f.from ? 'AND o.fpo_date >= ?' : ''} ${f.to ? 'AND o.fpo_date <= ?' : ''}
      GROUP BY so.id, o.sub_process ORDER BY job_no, process`, [cid, ...(f.so_id ? [f.so_id] : []), ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]),

  /** Vendor-wise process cost: value of good KG received, billed, still to bill. */
  'vendor-process-cost': async (cid, f) => query<any>(
    `SELECT p.party_name vendor, i.sub_process process, COUNT(*) grns, ROUND(SUM(i.input_kg), 3) input_kg, ROUND(SUM(i.good_kg), 3) good_kg,
            ROUND(SUM(i.good_kg * COALESCE(o.rate_per_kg, 0)), 2) value,
            ROUND(SUM(IF(b.status = 'POSTED', (SELECT COALESCE(SUM(bl.amount), 0) FROM trx_fabric_process_bill_line bl WHERE bl.bill_id = b.id AND bl.line_type = 'GRN' AND bl.ref_id = i.id), 0)), 2) billed,
            SUM(i.bill_id IS NULL OR b.status <> 'POSTED') unbilled_grns
       FROM trx_fabric_process_inward i JOIN trx_fabric_process_order o ON o.id = i.fpo_id LEFT JOIN mst_party p ON p.id = i.vendor_id LEFT JOIN trx_fabric_process_bill b ON b.id = i.bill_id
      WHERE i.company_id = ? AND i.status = 'POSTED' ${f.vendor_id ? 'AND i.vendor_id = ?' : ''} ${f.from ? 'AND i.inward_date >= ?' : ''} ${f.to ? 'AND i.inward_date <= ?' : ''}
      GROUP BY i.vendor_id, i.sub_process ORDER BY vendor, process`, [cid, ...(f.vendor_id ? [f.vendor_id] : []), ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]),

  /** Pending dyeing / washing / compacting … per job: sent, back, pending at the unit; grey still to send. */
  'pending-process': async (cid, f) => {
    const rows = await query<any>(
      `SELECT COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, ri.so_id, o.sub_process process, COUNT(DISTINCT o.id) dcs, ROUND(SUM(ri.weight_kg), 3) sent_kg,
              ROUND(SUM(ri.good_kg + ri.reject_kg + ri.loss_kg), 3) back_kg, ROUND(SUM(ri.weight_kg - ri.good_kg - ri.reject_kg - ri.loss_kg), 3) pending_kg, MIN(o.fpo_date) oldest_dc
         FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id JOIN trx_sales_order so ON so.id = ri.so_id
        WHERE o.company_id = ? AND o.status NOT IN ('DRAFT', 'CANCELLED') ${f.so_id ? 'AND ri.so_id = ?' : ''}
        GROUP BY ri.so_id, o.sub_process HAVING pending_kg > 0.0005 OR ? = 1 ORDER BY oldest_dc`, [cid, ...(f.so_id ? [f.so_id] : []), f.so_id ? 1 : 0]);
    const grey = await query<any>(`SELECT fr.so_id, ROUND(SUM(fr.weight_kg - COALESCE(fr.issued_kg, 0)), 3) kg FROM trx_fabric_roll fr WHERE fr.company_id = ? AND fr.process_state = 'GREY'
        AND fr.qc_status = 'ACCEPTED' AND fr.stock_status <> 'CLOSED' AND fr.so_id IS NOT NULL GROUP BY fr.so_id`, [cid]);
    return rows.map((r) => ({ ...r, grey_not_sent_kg: r3(grey.find((g) => Number(g.so_id) === Number(r.so_id))?.kg) }));
  },

  /** Roll split / merge history. */
  'split-merge': async (cid, f) => query<any>(
    `SELECT DATE(h.event_time) date, h.event, h.roll_no, rr.roll_no related_roll, h.qty_kg, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, h.remarks reason, u.full_name user
       FROM trx_fabric_roll_history h LEFT JOIN trx_fabric_roll rr ON rr.id = h.related_roll_id LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_user u ON u.id = h.user_id
      WHERE h.company_id = ? AND h.event IN ('SPLIT', 'SPLIT_FROM', 'MERGE', 'MERGED_FROM') ${f.so_id ? 'AND h.so_id = ?' : ''} ORDER BY h.id DESC LIMIT 1000`, [cid, ...(f.so_id ? [f.so_id] : [])]),

  /** Complete job lifecycle: yarn → fabric → process → cutting, one row per job. */
  'job-lifecycle': async (cid, f) => query<any>(
    `SELECT COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, so.so_date, b.party_name buyer,
            (SELECT GROUP_CONCAT(DISTINCT st.style_code) FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = so.id) styles,
            (SELECT ROUND(SUM(required_qty), 3) FROM trx_job_material_requirement r WHERE r.so_id = so.id AND r.status = 'ACTIVE' AND r.material_type = 'YARN') planned_yarn_kg,
            (SELECT ROUND(COALESCE(SUM(gl.accepted_qty), 0), 3) FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id WHERE gl.so_id = so.id AND gl.material_type = 'YARN' AND COALESCE(gl.po_id, g.po_id) IS NOT NULL) yarn_purchased_kg,
            (SELECT ROUND(COALESCE(SUM(pi.issued_qty_kg), 0), 3) FROM trx_process_issue pi WHERE pi.so_id = so.id AND pi.src_type = 'KNITTING_PROGRAM') yarn_issued_kg,
            (SELECT ROUND(COALESCE(SUM(pr.output_qty), 0), 3) FROM trx_process_receipt pr JOIN trx_knitting_program kp ON kp.id = pr.src_id WHERE pr.src_type = 'KNITTING_PROGRAM' AND kp.so_id = so.id) fabric_knitted_kg,
            (SELECT ROUND(COALESCE(SUM(ri.weight_kg), 0), 3) FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id WHERE ri.so_id = so.id AND o.status NOT IN ('DRAFT', 'CANCELLED')) sent_to_process_kg,
            (SELECT ROUND(COALESCE(SUM(ri.good_kg), 0), 3) FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id WHERE ri.so_id = so.id AND o.status NOT IN ('DRAFT', 'CANCELLED')) processed_good_kg,
            (SELECT ROUND(COALESCE(SUM(fir.issue_kg), 0), 3) FROM trx_fabric_issue_roll fir JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id WHERE fr.so_id = so.id) issued_to_cutting_kg,
            (SELECT ROUND(COALESCE(SUM(fr.weight_kg - COALESCE(fr.issued_kg, 0)), 0), 3) FROM trx_fabric_roll fr WHERE fr.so_id = so.id AND fr.stock_status <> 'CLOSED') fabric_in_stock_kg
       FROM trx_sales_order so LEFT JOIN mst_party b ON b.id = so.buyer_id
      WHERE so.company_id = ? AND so.is_deleted = 0 ${f.so_id ? 'AND so.id = ?' : ''} ORDER BY so.so_date DESC, so.id DESC LIMIT 300`, [cid, ...(f.so_id ? [f.so_id] : [])]),
};

genealogyRouter.get('/genealogy-reports/:key', VIEW, ah(async (req, res) => {
  const fn = REPORTS[String(req.params.key)];
  if (!fn) throw NotFound('Unknown report');
  const f = z.object({ so_id: z.coerce.number().int().positive().optional(), vendor_id: z.coerce.number().int().positive().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), roll_no: z.string().trim().max(60).optional() }).parse(
    Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '' && v != null)));
  res.json({ data: await fn(req.user!.companyId, f) });
}));
