import { txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest } from '../../core/errors.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { nextDocNumber } from '../../core/numbering.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';

/**
 * Fabric roll inventory engine (client doc "C_ONE_ERP_Fabric_Roll_Management_Developer_Document", 23-Nov-2026).
 *
 * One physical piece of fabric = one roll record with a unique roll no. When the store cuts a roll, the parent is
 * closed as SPLIT and every piece becomes a child roll (parent → child genealogy kept for ever). A split is not an
 * issue: company stock does not change, except a cutting loss, which is booked separately (within tolerance, or
 * approved by a store supervisor). Every function here runs inside the caller's transaction and locks the rolls it
 * changes, so a roll cannot be split / issued twice at the same time.
 *
 *   allocRollNo / childRollNo   unique roll nos (company-wide unique key uq_froll_company_rollno)
 *   planSplit / postSplit       split (cut) a roll into 2+ pieces, reservations carried to the pieces
 *   receiveBack                 KG coming back to a roll (return / DC cancel); a closed / split roll gets a return piece
 *   transferRolls               move rolls between stores / bins
 */

const EPS = 0.0005;
export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r3 = (x: unknown) => Math.round((Number(x) || 0) * 1000) / 1000;
const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

/** Statuses of a roll that is no longer a physical piece in stock. */
export const DEAD_STATUSES = ['CLOSED', 'SPLIT', 'MERGED'];
export const isDeadRoll = (status: unknown) => DEAD_STATUSES.includes(String(status ?? ''));
/** SQL: the roll is still a physical piece (not closed / split / merged). */
export const LIVE_ROLL_SQL = (a = 'fr') => `${a}.stock_status NOT IN ('CLOSED', 'SPLIT', 'MERGED')`;

export type OutputType = 'STORE' | 'ISSUE' | 'QC_HOLD' | 'DAMAGE';
export const OUTPUT_TYPES: OutputType[] = ['STORE', 'ISSUE', 'QC_HOLD', 'DAMAGE'];
export const SPLIT_REASONS = ['PROCESS_ISSUE', 'CONTRACTOR_ISSUE', 'CUTTING', 'DAMAGE_REMOVAL', 'STORE_TRANSFER', 'QC_SEPARATION', 'AUTO_DC', 'OTHER'] as const;

export interface RollCtx { cid: number; userId: number; canApprove: boolean }

// ------------------------------------------------------------------ roll numbers

/** The wanted roll no if no roll of the company has it, else `alt`, else `<alt or wanted>-2`, -3 … (max 60 chars). */
export async function allocRollNo(tx: Tx, cid: number, wanted: string, alt?: string | null): Promise<string> {
  const clean = (s: string) => s.trim().slice(0, 60);
  const taken = async (s: string) => !!(await txQueryOne(tx, 'SELECT id FROM trx_fabric_roll WHERE company_id = ? AND roll_no = ? LIMIT 1', [cid, s]));
  const w = clean(wanted);
  if (w && !(await taken(w))) return w;
  const a = alt ? clean(alt) : '';
  if (a && !(await taken(a))) return a;
  const base = (a || w || 'ROLL').slice(0, 54);
  for (let i = 2; i < 1000; i++) {
    const c = `${base}-${i}`;
    if (!(await taken(c))) return c;
  }
  throw BadRequest(`Could not make a unique roll no from ${base}`);
}

/**
 * Next free child roll no of a family: R-12 → R-12-S1, R-12-S2 …; a piece of R-12-S1 is R-12-S3 (no nesting, so roll
 * nos stay short — the genealogy keeps the real parent). kind S = split piece, R = returned piece, M = merged roll.
 */
export async function childRollNo(tx: Tx, cid: number, parentNo: string, kind: 'S' | 'R' | 'M'): Promise<string> {
  const root = String(parentNo).replace(/(-[SRM]\d+)+$/, '').slice(0, 52);
  const rows = await txQuery<any>(tx, 'SELECT roll_no FROM trx_fabric_roll WHERE company_id = ? AND roll_no LIKE ?', [cid, `${root.replace(/[\\%_]/g, (c) => `\\${c}`)}-${kind}%`]);
  const re = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${kind}(\\d+)$`);
  let max = 0;
  for (const r of rows) { const m = re.exec(String(r.roll_no)); if (m) max = Math.max(max, Number(m[1])); }
  return allocRollNo(tx, cid, `${root}-${kind}${max + 1}`);
}

/** Refuses a roll that is no longer a physical piece, naming where its KG went. */
export async function assertRollLive(tx: Tx, roll: any, action = 'used') {
  if (!isDeadRoll(roll?.stock_status)) return;
  if (roll.stock_status === 'SPLIT' || roll.stock_status === 'MERGED') {
    const kids = await txQuery<any>(tx, `SELECT roll_no FROM trx_fabric_roll WHERE parent_roll_id = ? AND roll_origin IN ('SPLIT', 'MERGE') ORDER BY id`, [roll.id]);
    const merged = roll.stock_status === 'MERGED'
      ? await txQueryOne<any>(tx, `SELECT rr.roll_no FROM trx_fabric_roll_history h JOIN trx_fabric_roll rr ON rr.id = h.related_roll_id WHERE h.roll_id = ? AND h.event = 'MERGE' ORDER BY h.id DESC LIMIT 1`, [roll.id])
      : null;
    const where = roll.stock_status === 'SPLIT' ? (kids.length ? ` — use its pieces ${kids.map((k) => k.roll_no).join(', ')}` : '') : (merged ? ` — use ${merged.roll_no}` : '');
    throw BadRequest(`Roll ${roll.roll_no} was ${roll.stock_status === 'SPLIT' ? 'cut into pieces' : 'merged'} and cannot be ${action}${where}`);
  }
  throw BadRequest(`Roll ${roll.roll_no} is closed and cannot be ${action}`);
}

// ------------------------------------------------------------------ settings

export async function splitSettings(tx: Tx, cid: number) {
  const rows = await txQuery<any>(tx, `SELECT setting_key k, setting_value v FROM cfg_system_setting WHERE company_id = ?
      AND setting_key IN ('ROLL_SPLIT_TOLERANCE_KG', 'ROLL_SPLIT_TOLERANCE_PCT', 'FABRIC_PARTIAL_ISSUE_SPLIT')`, [cid]);
  const g = (k: string, d: number) => { const r = rows.find((x) => x.k === k); const v = Number(r?.v); return r && r.v !== '' && r.v != null && Number.isFinite(v) ? v : d; };
  return { tolKg: Math.max(0, g('ROLL_SPLIT_TOLERANCE_KG', 0.05)), tolPct: Math.max(0, g('ROLL_SPLIT_TOLERANCE_PCT', 0.5)), autoSplitOnPartialIssue: g('FABRIC_PARTIAL_ISSUE_SPLIT', 1) === 1 };
}

// ------------------------------------------------------------------ roll copy

const COPY_SKIP = new Set(['id', 'created_at', 'updated_at']);
/** A new roll row copied from `src` (fabric, lot, shade, GSM, Dia, job, GRN, process state, colour, QC data …) with `over`. */
export async function insertRollFrom(tx: Tx, src: any, over: Record<string, unknown>) {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) if (!COPY_SKIP.has(k)) row[k] = v;
  Object.assign(row, over);
  if (row.original_weight_kg === undefined || over.weight_kg !== undefined) row.original_weight_kg = row.weight_kg;
  const cols = Object.keys(row);
  const r = await txExecute(tx, `INSERT INTO trx_fabric_roll (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
  return Number(r.insertId);
}

export async function rollHistory(tx: Tx, cid: number, userId: number, h: {
  roll_id: number; roll_no: string; event: string; ref_type: string; ref_id?: number | null; ref_no?: string | null; qty: number;
  so_id?: number | null; related?: number | null; from?: string | null; to?: string | null; remarks?: string | null;
}) {
  await txExecute(tx, `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, from_place, to_place, qty_kg, so_id, related_roll_id, remarks, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [cid, h.roll_id, h.roll_no, h.event.slice(0, 30), h.ref_type.slice(0, 30), h.ref_id ?? null, h.ref_no ?? null, h.from ? String(h.from).slice(0, 120) : null, h.to ? String(h.to).slice(0, 120) : null, r3(h.qty), h.so_id ?? null, h.related ?? null,
   h.remarks ? String(h.remarks).slice(0, 255) : null, userId]);
}

async function whName(tx: Tx, id: number | null | undefined) {
  if (!id) return null;
  return (await txQueryOne<any>(tx, 'SELECT warehouse_name FROM mst_warehouse WHERE id = ?', [id]))?.warehouse_name ?? null;
}

// ------------------------------------------------------------------ reservations on a roll

interface QuoteHold { id: number; quotation_id: number; quotation_no: string; qty_kg: number; sent_kg: number; open_kg: number; qty_m: number | null }
interface LayHold { id: number; lay_id: number; lay_no: string | null; alloc_kg: number }

async function rollHolds(tx: Tx, rollId: number) {
  const quotes = (await txQuery<any>(tx, `SELECT qr.id, qr.quotation_id, q.quotation_no, qr.qty_kg, qr.qty_m,
        COALESCE((SELECT SUM(ri.weight_kg) FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
                   WHERE ri.fabric_roll_id = qr.fabric_roll_id AND o.quotation_id = qr.quotation_id AND o.status <> 'CANCELLED'), 0) sent_kg
      FROM trx_quotation_roll qr JOIN trx_quotation q ON q.id = qr.quotation_id LEFT JOIN cfg_status cs ON cs.id = q.status_id
     WHERE qr.fabric_roll_id = ? AND COALESCE(q.is_deleted, 0) = 0 AND COALESCE(cs.code, '') NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'LOST')
     ORDER BY qr.id FOR UPDATE`, [rollId])).map((r) => ({ ...r, qty_kg: n(r.qty_kg), sent_kg: n(r.sent_kg), open_kg: r3(Math.max(0, n(r.qty_kg) - n(r.sent_kg))) })) as QuoteHold[];
  const lays = (await txQuery<any>(tx, `SELECT a.id, a.lay_id, lp.lay_no, a.alloc_kg FROM trx_lay_roll_alloc a LEFT JOIN trx_lay_plan lp ON lp.id = a.lay_id
     WHERE a.fabric_roll_id = ? AND a.status = 'RESERVED' ORDER BY a.alloc_kg DESC, a.id FOR UPDATE`, [rollId])).map((r) => ({ ...r, alloc_kg: n(r.alloc_kg) })) as LayHold[];
  const drafts = await txQuery<any>(tx, `SELECT o.id, o.fpo_no, ri.weight_kg FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
     WHERE ri.fabric_roll_id = ? AND ri.status = 'DRAFT' AND o.status = 'DRAFT'`, [rollId]);
  return { quotes: quotes.filter((q) => q.open_kg > EPS), allQuotes: quotes, lays, drafts };
}

// ------------------------------------------------------------------ split

export interface SplitPiece {
  kg: number; meters?: number | null; output_type?: OutputType; warehouse_id?: number | null; location_bin?: string | null; remarks?: string | null;
}
export interface SplitInput {
  roll_id: number;
  pieces: SplitPiece[];
  reason_code: string;
  remarks?: string | null;
  measurement_source?: 'WEIGHING_SCALE' | 'MANUAL' | 'SYSTEM';
  source?: 'MANUAL' | 'PROCESS_DC' | 'JOBWORK_DC';
  source_ref?: { type: string; id?: number | null; no?: string | null } | null;
  /** The ISSUE piece goes out on a DC of this quotation: its open allocation moves to that piece first. */
  issue_quotation_id?: number | null;
  /** Ignore draft process DCs of this DC (it is being confirmed). */
  ignore_draft_fpo_id?: number | null;
}

export interface SplitPlan {
  roll: any; input_kg: number; output_kg: number; variance_kg: number; tolerance_kg: number; needs_approval: boolean;
  input_m: number | null; output_m: number | null;
  pieces: (SplitPiece & { output_type: OutputType; line_no: number; carries: string[] })[];
  moves: { quote: { hold: QuoteHold; piece: number; kg: number }[]; lay: { hold: LayHold; piece: number }[] };
  problems: string[]; warnings: string[];
}

/** Validates a split without posting (also used by the preview endpoint). Locks the roll. */
export async function planSplit(tx: Tx, ctx: RollCtx, input: SplitInput): Promise<SplitPlan> {
  const roll = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE', [input.roll_id, ctx.cid]);
  if (!roll) throw BadRequest(`Roll #${input.roll_id} not found`);
  const problems: string[] = []; const warnings: string[] = [];
  if (isDeadRoll(roll.stock_status)) await assertRollLive(tx, roll, 'cut');
  // a DC cut is checked by the DC itself (e.g. a reprocess DC sends returned / rejected fabric)
  if ((input.source ?? 'MANUAL') === 'MANUAL' && !['ACCEPTED', 'HOLD'].includes(String(roll.qc_status))) problems.push(`${roll.roll_no}: QC is ${String(roll.qc_status).toLowerCase()} — only accepted or held rolls can be cut`);
  const left = r3(n(roll.weight_kg) - n(roll.issued_kg));
  if (left <= EPS) problems.push(`${roll.roll_no} has no KG in store to cut`);
  if (input.pieces.length < 2) problems.push('Cut the roll into at least two pieces');
  if (input.pieces.length > 20) problems.push('At most 20 pieces in one split');
  const pending = await txQueryOne<any>(tx, `SELECT split_no FROM trx_fabric_roll_split WHERE parent_roll_id = ? AND status = 'PENDING_APPROVAL' LIMIT 1`, [roll.id]);
  if (pending) problems.push(`${roll.roll_no} already has split ${pending.split_no} waiting for approval`);

  const pieces = input.pieces.map((p, i) => ({ ...p, kg: r3(p.kg), output_type: (p.output_type ?? 'STORE') as OutputType, line_no: i + 1, carries: [] as string[] }));
  for (const p of pieces) {
    if (!(p.kg > 0)) problems.push(`Piece ${p.line_no}: enter its KG`);
    if (!OUTPUT_TYPES.includes(p.output_type)) problems.push(`Piece ${p.line_no}: unknown output type ${p.output_type}`);
    if (p.meters != null && !(Number(p.meters) > 0)) problems.push(`Piece ${p.line_no}: measured meter must be more than 0`);
    if (p.warehouse_id) {
      const wh = await txQueryOne<any>(tx, 'SELECT id FROM mst_warehouse WHERE id = ? AND company_id = ?', [p.warehouse_id, ctx.cid]);
      if (!wh) problems.push(`Piece ${p.line_no}: store not found`);
    }
  }
  const output = r3(pieces.reduce((a, p) => a + p.kg, 0));
  const variance = r3(left - output);
  if (variance < -EPS) problems.push(`The pieces (${output} KG) are more than the ${left} KG on ${roll.roll_no}`);
  const st = await splitSettings(tx, ctx.cid);
  const tolerance = r3(Math.max(st.tolKg, left * st.tolPct / 100));
  const needsApproval = variance > tolerance + EPS;
  if (variance > EPS) warnings.push(`${variance} KG cutting loss (tolerance ${tolerance} KG)${needsApproval ? ' — needs a store supervisor\'s approval' : ' — booked as loss'}`);

  // meters: measured on every piece → checked against the roll; otherwise carried pro-rata
  const mPerKg = n(roll.weight_kg) > 0 ? n(roll.actual_meters || roll.meters || roll.calc_meters) / n(roll.weight_kg) : 0;
  const inputM = mPerKg > 0 ? r3(left * mPerKg) : null;
  const outputM = pieces.every((p) => p.meters != null) ? r3(pieces.reduce((a, p) => a + n(p.meters), 0)) : null;
  if (inputM && outputM && outputM > inputM * 1.05 + 0.5) warnings.push(`Measured meters (${outputM} M) are more than the roll's ${inputM} M — check the measurement`);

  // reservations: the KG held for a lay / a process quotation must stay on a piece that stays in store
  const holds = await rollHolds(tx, roll.id);
  const otherDrafts = holds.drafts.filter((d) => Number(d.id) !== Number(input.ignore_draft_fpo_id ?? 0));
  if (otherDrafts.length) problems.push(`${roll.roll_no} is on draft process DC ${[...new Set(otherDrafts.map((d) => d.fpo_no))].join(', ')} — confirm or remove it first`);
  const cap = pieces.map((p) => (p.output_type === 'STORE' || p.output_type === 'ISSUE' ? p.kg : 0));
  const quoteMoves: SplitPlan['moves']['quote'] = []; const layMoves: SplitPlan['moves']['lay'] = [];
  const give = (h: QuoteHold, kg: number, order: number[]) => {
    let need = kg;
    for (const i of order) {
      if (need <= EPS) break;
      const take = r3(Math.min(need, cap[i]));
      if (take > EPS) { quoteMoves.push({ hold: h, piece: i, kg: take }); cap[i] = r3(cap[i] - take); need = r3(need - take); pieces[i].carries.push(`${take} KG of quotation ${h.quotation_no}`); }
    }
    return need;
  };
  const storeIdx = pieces.map((p, i) => (p.output_type === 'STORE' ? i : -1)).filter((i) => i >= 0);
  const issueIdx = pieces.map((p, i) => (p.output_type === 'ISSUE' ? i : -1)).filter((i) => i >= 0);
  // the DC's own quotation goes to the piece being issued first
  const isDcQuote = (q: QuoteHold) => !!input.issue_quotation_id && Number(q.quotation_id) === Number(input.issue_quotation_id);
  const quotes = [...holds.quotes].sort((a, b) => Number(isDcQuote(b)) - Number(isDcQuote(a)));
  for (const lay of holds.lays) {
    const i = storeIdx.filter((k) => cap[k] + EPS >= lay.alloc_kg).sort((a, b) => cap[a] - cap[b])[0];
    if (i === undefined) problems.push(`${r3(lay.alloc_kg)} KG of ${roll.roll_no} is reserved for lay ${lay.lay_no ?? `#${lay.lay_id}`} — keep a store piece of at least that KG, or release the reservation first`);
    else { layMoves.push({ hold: lay, piece: i }); cap[i] = r3(cap[i] - lay.alloc_kg); pieces[i].carries.push(`${r3(lay.alloc_kg)} KG for lay ${lay.lay_no ?? lay.lay_id}`); }
  }
  for (const q of quotes) {
    const order = isDcQuote(q) ? [...issueIdx, ...storeIdx] : storeIdx;
    const short = give(q, q.open_kg, order);
    if (short > EPS) problems.push(`${r3(q.open_kg)} KG of ${roll.roll_no} is on process quotation ${q.quotation_no} — the pieces kept in store must hold it, or take the roll off the quotation first`);
  }
  return {
    roll, input_kg: left, output_kg: output, variance_kg: Math.max(0, variance), tolerance_kg: tolerance, needs_approval: needsApproval,
    input_m: inputM, output_m: outputM, pieces, moves: { quote: quoteMoves, lay: layMoves }, problems, warnings,
  };
}

/** Saves the split document. Within tolerance (or the user may approve) → posted now; else PENDING_APPROVAL. */
export async function requestSplit(tx: Tx, ctx: RollCtx, input: SplitInput) {
  const plan = await planSplit(tx, ctx, input);
  if (plan.problems.length) throw BadRequest(plan.problems.join('; '));
  const splitNo = await nextDocNumber(tx, ctx.cid, 'ROLL_SPLIT');
  const pend = plan.needs_approval && !ctx.canApprove;
  const ins = await txExecute(tx,
    `INSERT INTO trx_fabric_roll_split (company_id, split_no, split_date, parent_roll_id, parent_roll_no, reason_code, remarks, source, source_ref_type, source_ref_id, source_ref_no,
       measurement_source, input_kg, output_kg, variance_kg, tolerance_kg, input_m, output_m, status, requested_by)
     VALUES (?,?,CURDATE(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ctx.cid, splitNo, plan.roll.id, plan.roll.roll_no, input.reason_code, input.remarks ?? null, input.source ?? 'MANUAL', input.source_ref?.type ?? null, input.source_ref?.id ?? null,
     input.source_ref?.no ?? null, input.measurement_source ?? 'WEIGHING_SCALE', plan.input_kg, plan.output_kg, plan.variance_kg, plan.tolerance_kg, plan.input_m, plan.output_m,
     pend ? 'PENDING_APPROVAL' : 'POSTED', ctx.userId]);
  const splitId = Number(ins.insertId);
  for (const p of plan.pieces) {
    await txExecute(tx, `INSERT INTO trx_fabric_roll_split_line (split_id, line_no, output_type, weight_kg, length_m, warehouse_id, location_bin, remarks) VALUES (?,?,?,?,?,?,?,?)`,
      [splitId, p.line_no, p.output_type, p.kg, p.meters != null ? r3(p.meters) : null, p.warehouse_id ?? null, p.location_bin ?? null, p.remarks ?? null]);
  }
  if (pend) {
    await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: plan.roll.id, roll_no: plan.roll.roll_no, event: 'SPLIT_REQUEST', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: splitNo,
      qty: plan.input_kg, so_id: plan.roll.so_id, remarks: `Cut into ${plan.pieces.length} pieces, ${plan.variance_kg} KG loss — waiting for approval` });
    return { split_id: splitId, split_no: splitNo, status: 'PENDING_APPROVAL' as const, plan, children: [] as PostedChild[] };
  }
  const children = await postSplitDoc(tx, ctx, splitId, input, plan);
  return { split_id: splitId, split_no: splitNo, status: 'POSTED' as const, plan, children };
}

export interface PostedChild { id: number; roll_no: string; weight_kg: number; output_type: OutputType; line_no: number; warehouse_id: number | null }

/** Approves a pending split: re-checks the roll (it may have changed since the request) and posts it. */
export async function approveSplit(tx: Tx, ctx: RollCtx, splitId: number, remarks: string | null) {
  const s = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll_split WHERE id = ? AND company_id = ? FOR UPDATE', [splitId, ctx.cid]);
  if (!s) throw BadRequest('Split not found');
  if (s.status !== 'PENDING_APPROVAL') throw BadRequest(`${s.split_no} is ${String(s.status).toLowerCase().replace('_', ' ')}`);
  if (Number(s.requested_by) === ctx.userId && !ctx.canApprove) throw BadRequest('You cannot approve your own split');
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_roll_split_line WHERE split_id = ? ORDER BY line_no', [splitId]);
  // the pending request is not itself a blocker for its own approval
  await txExecute(tx, `UPDATE trx_fabric_roll_split SET status = 'APPROVING' WHERE id = ?`, [splitId]);
  const input: SplitInput = {
    roll_id: Number(s.parent_roll_id), reason_code: s.reason_code, remarks: s.remarks, measurement_source: s.measurement_source, source: s.source,
    pieces: lines.map((l) => ({ kg: n(l.weight_kg), meters: l.length_m != null ? n(l.length_m) : null, output_type: l.output_type, warehouse_id: l.warehouse_id, location_bin: l.location_bin, remarks: l.remarks })),
  };
  const plan = await planSplit(tx, { ...ctx, canApprove: true }, input);
  if (Math.abs(plan.input_kg - n(s.input_kg)) > EPS) throw BadRequest(`${s.parent_roll_no} now has ${plan.input_kg} KG (the request was for ${r3(s.input_kg)} KG) — reject this request and cut it again`);
  if (plan.problems.length) throw BadRequest(plan.problems.join('; '));
  await txExecute(tx, `UPDATE trx_fabric_roll_split SET approved_by = ?, approved_at = NOW(), approval_remarks = ? WHERE id = ?`, [ctx.userId, remarks, splitId]);
  return postSplitDoc(tx, ctx, splitId, input, plan);
}

export async function rejectSplit(tx: Tx, ctx: RollCtx, splitId: number, remarks: string) {
  const s = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll_split WHERE id = ? AND company_id = ? FOR UPDATE', [splitId, ctx.cid]);
  if (!s) throw BadRequest('Split not found');
  if (s.status !== 'PENDING_APPROVAL') throw BadRequest(`${s.split_no} is ${String(s.status).toLowerCase().replace('_', ' ')}`);
  await txExecute(tx, `UPDATE trx_fabric_roll_split SET status = 'REJECTED', approved_by = ?, approved_at = NOW(), approval_remarks = ? WHERE id = ?`, [ctx.userId, remarks, splitId]);
  await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: Number(s.parent_roll_id), roll_no: s.parent_roll_no, event: 'SPLIT_REJECTED', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: s.split_no, qty: 0, remarks });
  return s;
}

async function postSplitDoc(tx: Tx, ctx: RollCtx, splitId: number, input: SplitInput, plan: SplitPlan): Promise<PostedChild[]> {
  const s = await txQueryOne<any>(tx, 'SELECT split_no FROM trx_fabric_roll_split WHERE id = ?', [splitId]);
  const fr = plan.roll;
  const parentWh = fr.warehouse_id ? Number(fr.warehouse_id) : null;
  const parentWhName = await whName(tx, parentWh);
  const mPerKg = n(fr.weight_kg) > 0 ? n(fr.meters) / n(fr.weight_kg) : 0;
  const scale = (col: string, kg: number) => (fr[col] != null && n(fr.weight_kg) > 0 ? r3(n(fr[col]) * kg / n(fr.weight_kg)) : null);
  const children: PostedChild[] = [];
  for (const p of plan.pieces) {
    const no = await childRollNo(tx, ctx.cid, fr.roll_no, 'S');
    const measured = p.meters != null;
    const wh = p.warehouse_id ? Number(p.warehouse_id) : parentWh;
    const qc = p.output_type === 'QC_HOLD' ? 'HOLD' : p.output_type === 'DAMAGE' ? 'REJECTED' : fr.qc_status;
    const id = await insertRollFrom(tx, fr, {
      roll_no: no, weight_kg: p.kg, original_weight_kg: p.kg, issued_kg: 0, parent_roll_id: fr.id, roll_origin: 'SPLIT', split_id: splitId,
      stock_status: qc === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED', qc_status: qc, warehouse_id: wh, location_bin: p.location_bin ?? (wh === parentWh ? fr.location_bin : null),
      meters: measured ? r3(p.meters) : (fr.meters != null ? r3(p.kg * mPerKg) : null),
      calc_meters: scale('calc_meters', p.kg), actual_meters: measured ? r3(p.meters) : null, measured_meters: measured ? 1 : 0,
      remarks: `${s.split_no}: piece ${p.line_no} of ${fr.roll_no}${p.remarks ? ` — ${p.remarks}` : ''}`.slice(0, 255),
    });
    children.push({ id, roll_no: no, weight_kg: p.kg, output_type: p.output_type, line_no: p.line_no, warehouse_id: wh });
    await txExecute(tx, 'UPDATE trx_fabric_roll_split_line SET child_roll_id = ?, child_roll_no = ? WHERE split_id = ? AND line_no = ?', [id, no, splitId, p.line_no]);
    await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: fr.id, roll_no: fr.roll_no, event: 'SPLIT', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: s.split_no, qty: p.kg, so_id: fr.so_id, related: id,
      remarks: `Piece ${p.line_no} → ${no} (${p.output_type.toLowerCase().replace('_', ' ')})${input.remarks ? `: ${input.remarks}` : ''}` });
    await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: id, roll_no: no, event: 'SPLIT_FROM', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: s.split_no, qty: p.kg, so_id: fr.so_id, related: fr.id,
      to: await whName(tx, wh), remarks: `Cut from ${fr.roll_no}` });
    if (wh && parentWh && wh !== parentWh) {
      await postLedger(tx, { companyId: ctx.cid, warehouseId: parentWh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, soId: fr.so_id ?? null, txnType: 'TRANSFER_OUT', refType: 'ROLL_SPLIT', refId: splitId, qtyOut: p.kg, uomId: UOM_KG, createdBy: ctx.userId });
      await postLedger(tx, { companyId: ctx.cid, warehouseId: wh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, soId: fr.so_id ?? null, txnType: 'TRANSFER_IN', refType: 'ROLL_SPLIT', refId: splitId, qtyIn: p.kg, uomId: UOM_KG, createdBy: ctx.userId });
      await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: id, roll_no: no, event: 'TRANSFER', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: s.split_no, qty: p.kg, so_id: fr.so_id, from: parentWhName, to: await whName(tx, wh) });
    }
  }
  // cutting loss: never silent — booked on the parent and out of stock
  let lossValue: number | null = null;
  let costPerKg: number | null = null;
  try {
    const { rollCost } = await import('../stock/genealogy.routes.js');
    costPerKg = (await rollCost(ctx.cid, Number(fr.id))).cost_per_kg;
  } catch { costPerKg = null; }
  if (plan.variance_kg > EPS) {
    lossValue = costPerKg != null ? r2(plan.variance_kg * costPerKg) : null;
    await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: fr.id, roll_no: fr.roll_no, event: 'CUT_LOSS', ref_type: 'ROLL_SPLIT', ref_id: splitId, ref_no: s.split_no, qty: plan.variance_kg, so_id: fr.so_id,
      remarks: `Cutting loss ${plan.variance_kg} KG${plan.needs_approval ? ' (approved)' : ' (within tolerance)'}` });
    if (parentWh) await postLedger(tx, { companyId: ctx.cid, warehouseId: parentWh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, soId: fr.so_id ?? null, txnType: 'ADJUST', refType: 'ROLL_SPLIT_LOSS', refId: splitId, qtyOut: plan.variance_kg, uomId: UOM_KG, rate: costPerKg ?? 0, createdBy: ctx.userId });
  }
  // reservations follow the KG
  for (const m of plan.moves.lay) {
    const c = children[m.piece];
    await txExecute(tx, 'UPDATE trx_lay_roll_alloc SET fabric_roll_id = ?, roll_no = ?, roll_balance_kg = ? WHERE id = ?', [c.id, c.roll_no, r3(c.weight_kg - m.hold.alloc_kg), m.hold.id]);
  }
  const byHold = new Map<number, { hold: QuoteHold; parts: { piece: number; kg: number }[] }>();
  for (const m of plan.moves.quote) {
    const e = byHold.get(m.hold.id) ?? { hold: m.hold, parts: [] }; e.parts.push({ piece: m.piece, kg: m.kg }); byHold.set(m.hold.id, e);
  }
  for (const { hold, parts } of byHold.values()) {
    const src = await txQueryOne<any>(tx, 'SELECT * FROM trx_quotation_roll WHERE id = ?', [hold.id]);
    const mPer = hold.qty_kg > 0 && hold.qty_m != null ? n(hold.qty_m) / hold.qty_kg : null;
    const keep = r3(hold.sent_kg);
    let first = true;
    for (const part of parts) {
      const c = children[part.piece];
      if (first && keep <= EPS) {
        await txExecute(tx, 'UPDATE trx_quotation_roll SET fabric_roll_id = ?, roll_no = ?, qty_kg = ?, qty_m = ? WHERE id = ?', [c.id, c.roll_no, part.kg, mPer != null ? r3(part.kg * mPer) : null, hold.id]);
      } else {
        await txExecute(tx, `INSERT INTO trx_quotation_roll (company_id, quotation_id, quotation_line_id, line_sort, fabric_roll_id, so_id, roll_no, qty_kg, qty_m, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [src.company_id, src.quotation_id, src.quotation_line_id, src.line_sort, c.id, src.so_id, c.roll_no, part.kg, mPer != null ? r3(part.kg * mPer) : null, ctx.userId]);
      }
      first = false;
    }
    if (keep > EPS) await txExecute(tx, 'UPDATE trx_quotation_roll SET qty_kg = ?, qty_m = ? WHERE id = ?', [keep, mPer != null ? r3(keep * mPer) : null, hold.id]);
  }
  // parent: no longer a physical piece (its KG left = 0 everywhere), old label void
  await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = weight_kg, stock_status = 'SPLIT', split_id = ?, remarks = LEFT(CONCAT(COALESCE(remarks, ''), ?), 255) WHERE id = ?`,
    [splitId, ` Cut on ${s.split_no} into ${children.map((c) => c.roll_no).join(', ')}`, fr.id]);
  await txExecute(tx, `UPDATE trx_fabric_roll_label SET status = 'VOID' WHERE roll_id = ? AND status = 'ACTIVE'`, [fr.id]);
  await txExecute(tx, `UPDATE trx_fabric_roll_split SET status = 'POSTED', posted_by = ?, posted_at = NOW(), cost_per_kg = ?, loss_value = ? WHERE id = ?`,
    [ctx.userId, costPerKg, lossValue, splitId]);
  return children;
}

// ------------------------------------------------------------------ issue helper: cut the part sent on a DC

/**
 * A DC takes `kg` of a roll. When it is less than the roll's KG in store and the company cuts rolls on partial issue
 * (FABRIC_PARTIAL_ISSUE_SPLIT = 1), the roll is split into the piece sent (ISSUE) and the piece left in store, and the
 * DC uses the piece sent. Otherwise the same roll is returned (one roll no, balance kept on it).
 */
export async function pieceForIssue(tx: Tx, ctx: RollCtx, roll: any, kg: number, src: { source: 'PROCESS_DC' | 'JOBWORK_DC'; ref_type: string; ref_id?: number | null; ref_no?: string | null; quotation_id?: number | null; fpo_id?: number | null }) {
  const left = r3(n(roll.weight_kg) - n(roll.issued_kg));
  const st = await splitSettings(tx, ctx.cid);
  if (!st.autoSplitOnPartialIssue || kg >= left - EPS) return { roll, split: null as null | { split_no: string; children: PostedChild[] } };
  const out = await requestSplit(tx, { ...ctx, canApprove: true }, {
    roll_id: Number(roll.id), reason_code: 'AUTO_DC', source: src.source, measurement_source: 'SYSTEM', source_ref: { type: src.ref_type, id: src.ref_id ?? null, no: src.ref_no ?? null },
    issue_quotation_id: src.quotation_id ?? null, ignore_draft_fpo_id: src.fpo_id ?? null,
    remarks: `${r3(kg)} KG sent on ${src.ref_no ?? src.ref_type}`,
    pieces: [{ kg: r3(kg), output_type: 'ISSUE', remarks: `Sent on ${src.ref_no ?? src.ref_type}` }, { kg: r3(left - kg), output_type: 'STORE', remarks: 'Left in store' }],
  });
  const piece = out.children.find((c) => c.output_type === 'ISSUE')!;
  const fresh = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [piece.id]);
  return { roll: fresh, split: { split_no: out.split_no, children: out.children } };
}

// ------------------------------------------------------------------ KG coming back

/**
 * `kg` comes back to the store against a roll (return from a contractor / cutting, DC cancelled). A live roll takes it
 * back (same piece, same label). A roll that is closed / split / merged is no longer a piece, so the KG becomes a new
 * return piece (child roll, its own roll no and label) — stock is never hidden on a closed roll.
 */
export async function receiveBack(tx: Tx, ctx: RollCtx, rollId: number, kg: number, ref: { type: string; id?: number | null; no?: string | null; event: string; remarks?: string | null; meters?: number | null }) {
  const roll = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [rollId]);
  if (!roll) throw BadRequest(`Roll #${rollId} not found`);
  const q = r3(kg);
  if (!isDeadRoll(roll.stock_status)) {
    await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = GREATEST(COALESCE(issued_kg, 0) - ?, 0) WHERE id = ?', [q, roll.id]);
    await refreshFabricRollStatus(tx, roll.id, { reopen: true });
    return { roll_id: Number(roll.id), roll_no: String(roll.roll_no), warehouse_id: roll.warehouse_id ? Number(roll.warehouse_id) : null, fabric_id: roll.fabric_id, created: false };
  }
  const no = await childRollNo(tx, ctx.cid, roll.roll_no, 'R');
  const mPerKg = n(roll.weight_kg) > 0 ? n(roll.meters) / n(roll.weight_kg) : 0;
  const id = await insertRollFrom(tx, roll, {
    roll_no: no, weight_kg: q, original_weight_kg: q, issued_kg: 0, parent_roll_id: roll.id, roll_origin: 'RETURN', split_id: null,
    stock_status: roll.qc_status === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED', meters: ref.meters != null ? r3(ref.meters) : (roll.meters != null ? r3(q * mPerKg) : null),
    calc_meters: roll.calc_meters != null && n(roll.weight_kg) > 0 ? r3(n(roll.calc_meters) * q / n(roll.weight_kg)) : null,
    actual_meters: ref.meters != null ? r3(ref.meters) : null, measured_meters: ref.meters != null ? 1 : 0,
    remarks: `Returned on ${ref.no ?? ref.type} from ${roll.roll_no}`.slice(0, 255),
  });
  await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: roll.id, roll_no: roll.roll_no, event: 'RETURN_PIECE', ref_type: ref.type, ref_id: ref.id ?? null, ref_no: ref.no ?? null, qty: q, so_id: roll.so_id, related: id,
    remarks: `${q} KG came back as ${no}${ref.remarks ? `: ${ref.remarks}` : ''}` });
  await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: id, roll_no: no, event: ref.event, ref_type: ref.type, ref_id: ref.id ?? null, ref_no: ref.no ?? null, qty: q, so_id: roll.so_id, related: roll.id,
    to: await whName(tx, roll.warehouse_id), remarks: `Returned piece of ${roll.roll_no}` });
  return { roll_id: id, roll_no: no, warehouse_id: roll.warehouse_id ? Number(roll.warehouse_id) : null, fabric_id: roll.fabric_id, created: true };
}

// ------------------------------------------------------------------ store / bin transfer

export async function transferRolls(tx: Tx, ctx: RollCtx, b: { roll_ids: number[]; to_warehouse_id: number; to_location_bin?: string | null; reason: string; date: string }) {
  const wh = await txQueryOne<any>(tx, 'SELECT id, warehouse_name FROM mst_warehouse WHERE id = ? AND company_id = ?', [b.to_warehouse_id, ctx.cid]);
  if (!wh) throw BadRequest('Destination store not found');
  if (new Set(b.roll_ids).size !== b.roll_ids.length) throw BadRequest('A roll is picked twice');
  const rolls: any[] = [];
  for (const id of [...b.roll_ids].sort((x, y) => x - y)) {
    const fr = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE', [id, ctx.cid]);
    if (!fr) throw BadRequest(`Roll #${id} not found`);
    await assertRollLive(tx, fr, 'moved');
    const left = r3(n(fr.weight_kg) - n(fr.issued_kg));
    if (left <= EPS) throw BadRequest(`${fr.roll_no} has no KG in store`);
    const draft = await txQueryOne<any>(tx, `SELECT o.fpo_no FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id WHERE ri.fabric_roll_id = ? AND ri.status = 'DRAFT' AND o.status = 'DRAFT' LIMIT 1`, [fr.id]);
    if (draft) throw BadRequest(`${fr.roll_no} is on draft process DC ${draft.fpo_no} — confirm or remove it first`);
    const bin = b.to_location_bin ?? null;
    if (Number(fr.warehouse_id) === wh.id && String(fr.location_bin ?? '') === String(bin ?? '')) throw BadRequest(`${fr.roll_no} is already in ${wh.warehouse_name}${bin ? ` / ${bin}` : ''}`);
    rolls.push({ fr, left });
  }
  if (!rolls.length) throw BadRequest('Pick the rolls to move');
  const no = await nextDocNumber(tx, ctx.cid, 'ROLL_TRANSFER');
  const total = r3(rolls.reduce((a, r) => a + r.left, 0));
  const ins = await txExecute(tx, `INSERT INTO trx_fabric_roll_transfer (company_id, transfer_no, transfer_date, to_warehouse_id, to_location_bin, reason, total_rolls, total_kg, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [ctx.cid, no, b.date, wh.id, b.to_location_bin ?? null, b.reason, rolls.length, total, ctx.userId]);
  const tid = Number(ins.insertId);
  for (const { fr, left } of rolls) {
    const fromWh = fr.warehouse_id ? Number(fr.warehouse_id) : null;
    await txExecute(tx, `INSERT INTO trx_fabric_roll_transfer_line (transfer_id, fabric_roll_id, roll_no, from_warehouse_id, from_location_bin, qty_kg) VALUES (?,?,?,?,?,?)`,
      [tid, fr.id, fr.roll_no, fromWh, fr.location_bin ?? null, left]);
    await txExecute(tx, 'UPDATE trx_fabric_roll SET warehouse_id = ?, location_bin = ? WHERE id = ?', [wh.id, b.to_location_bin ?? null, fr.id]);
    if (fromWh !== wh.id) {
      if (fromWh) await postLedger(tx, { companyId: ctx.cid, warehouseId: fromWh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, soId: fr.so_id ?? null, txnType: 'TRANSFER_OUT', refType: 'ROLL_TRANSFER', refId: tid, qtyOut: left, uomId: UOM_KG, createdBy: ctx.userId });
      await postLedger(tx, { companyId: ctx.cid, warehouseId: wh.id, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, soId: fr.so_id ?? null, txnType: 'TRANSFER_IN', refType: 'ROLL_TRANSFER', refId: tid, qtyIn: left, uomId: UOM_KG, createdBy: ctx.userId });
    }
    await rollHistory(tx, ctx.cid, ctx.userId, { roll_id: fr.id, roll_no: fr.roll_no, event: fromWh !== wh.id ? 'TRANSFER' : 'BIN_MOVE', ref_type: 'ROLL_TRANSFER', ref_id: tid, ref_no: no, qty: left, so_id: fr.so_id,
      from: `${(await whName(tx, fromWh)) ?? ''}${fr.location_bin ? ` / ${fr.location_bin}` : ''}`, to: `${wh.warehouse_name}${b.to_location_bin ? ` / ${b.to_location_bin}` : ''}`, remarks: b.reason });
  }
  return { id: tid, transfer_no: no, rolls: rolls.length, total_kg: total, to: wh.warehouse_name };
}
