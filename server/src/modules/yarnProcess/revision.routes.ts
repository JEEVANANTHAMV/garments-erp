import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import type { SrcType } from '../../core/processEngine.js';

/**
 * Process revisions (doc §22, §29).
 *
 * A released or completed document must not be edited in place — it is
 * historical. Instead a revision is raised: the prior state is snapshotted with
 * a reason, then the permitted fields are changed and the revision number is
 * bumped. That keeps the change auditable and reversible.
 */
export const revisionRouter = Router();

const SRC_TYPES = ['YARN_PROCESS', 'KNITTING_PROGRAM', 'COLLAR_PROGRAM'] as const;

const SRC: Record<SrcType, { table: string; label: string; noField: string }> = {
  YARN_PROCESS:     { table: 'trx_yarn_process',     label: 'process',         noField: 'process_no' },
  KNITTING_PROGRAM: { table: 'trx_knitting_program', label: 'knitting program', noField: 'program_no' },
  COLLAR_PROGRAM:   { table: 'trx_collar_program',   label: 'collar program',   noField: 'program_no' },
};

/**
 * Fields a revision may change. Quantities and dates are the point of a
 * revision; identity, status and numbering are not, so they stay out.
 */
const REVISABLE: Record<SrcType, string[]> = {
  YARN_PROCESS: [
    'input_qty_kg', 'expected_loss_pct', 'required_date', 'priority',
    'job_work_type', 'vendor_id', 'warehouse_id', 'remarks',
  ],
  KNITTING_PROGRAM: [
    'required_qty_kg', 'required_date', 'gsm', 'dia', 'gauge', 'loop_length',
    'job_work_type', 'vendor_id', 'remarks',
  ],
  COLLAR_PROGRAM: [
    'required_date', 'colour', 'collar_type', 'gauge_needle',
    'job_work_type', 'vendor_id', 'remarks',
  ],
};

/** Snapshot the document and its child rows, so the prior state is recoverable. */
async function snapshot(srcType: SrcType, srcId: number): Promise<any> {
  const { table } = SRC[srcType];
  const header = await queryOne(`SELECT * FROM ${table} WHERE id = ?`, [srcId]);
  const snap: any = { header };

  if (srcType === 'YARN_PROCESS') {
    snap.dyeing   = await queryOne(`SELECT * FROM trx_yarn_process_dyeing WHERE process_id = ?`, [srcId]);
    snap.winding  = await queryOne(`SELECT * FROM trx_yarn_process_winding WHERE process_id = ?`, [srcId]);
    snap.twisting = await queryOne(`SELECT * FROM trx_yarn_process_twisting WHERE process_id = ?`, [srcId]);
  } else if (srcType === 'KNITTING_PROGRAM') {
    snap.yarns   = await query(`SELECT * FROM trx_knitting_program_yarns WHERE program_id = ?`, [srcId]);
    snap.stripes = await query(`SELECT * FROM trx_knitting_program_stripes WHERE program_id = ?`, [srcId]);
  } else {
    snap.sizes = await query(`SELECT * FROM trx_collar_program_size WHERE program_id = ?`, [srcId]);
  }
  return snap;
}

const reviseSchema = z.object({
  src_type: z.enum(SRC_TYPES),
  src_id: s.idReq(),
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500),
  changes: z.record(z.string(), z.any()).default({}),
  /** Reopen the document for execution rather than leaving it completed. */
  reopen_to: z.enum(['RELEASED', 'IN_PROGRESS']).optional(),
});

/** POST /process-revisions — raise a revision against a released/completed document. */
revisionRouter.post('/process-revisions', requirePermission('PROCESS.REVISE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = reviseSchema.parse(req.body);
  const { table, label, noField } = SRC[body.src_type];

  const doc = await queryOne<any>(
    `SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, [body.src_id, cid]);
  if (!doc) throw NotFound(`${label} not found`);

  // A revision is only meaningful once a document has left the editable phase;
  // before that an ordinary edit is the right tool.
  const revisable = ['RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
                     'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED', 'COMPLETED'];
  if (!revisable.includes(doc.status)) {
    throw BadRequest(
      `This ${label} is still ${String(doc.status).toLowerCase()} — edit it directly instead of revising it.`);
  }
  if (doc.status === 'CANCELLED') throw BadRequest(`A cancelled ${label} cannot be revised`);

  // Only the fields this document type allows a revision to touch.
  const allowed = REVISABLE[body.src_type];
  const rejected = Object.keys(body.changes).filter((k) => !allowed.includes(k));
  if (rejected.length) {
    throw BadRequest(
      `These fields cannot be changed by revision: ${rejected.join(', ')}. ` +
      `Revisable fields are: ${allowed.join(', ')}.`);
  }

  const snap = await snapshot(body.src_type, body.src_id);

  const result = await transaction(async (tx) => {
    const last = await txQueryOne<{ n: number }>(
      tx, `SELECT COALESCE(MAX(revision_no), 0) AS n FROM trx_process_revision
            WHERE src_type = ? AND src_id = ?`, [body.src_type, body.src_id]);
    const revNo = Number(last?.n ?? 0) + 1;

    const statusAfter = body.reopen_to ?? doc.status;

    const r = await txExecute(tx,
      `INSERT INTO trx_process_revision
         (company_id, src_type, src_id, revision_no, reason, status_before, status_after,
          snapshot_json, changes_json, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, body.src_type, body.src_id, revNo, body.reason, doc.status, statusAfter,
       JSON.stringify(snap), JSON.stringify(body.changes), req.user!.id]);

    // Apply the permitted changes, then stamp the new revision number.
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, v] of Object.entries(body.changes)) {
      sets.push(`${k} = ?`); vals.push(v === '' ? null : v);
    }
    sets.push('revision_no = ?'); vals.push(revNo);
    if (body.reopen_to) { sets.push('status = ?'); vals.push(body.reopen_to); }

    await txExecute(tx,
      `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
      [...vals, body.src_id, cid]);

    return { id: r.insertId, revision_no: revNo, document_no: doc[noField] };
  });

  await audit(req, 'trx_process_revision', result.id, 'INSERT', doc, {
    revision_no: result.revision_no, reason: body.reason, changes: body.changes,
  });
  res.status(201).json({ success: true, data: result });
}));

/** GET /process-revisions — revision history for a document. */
revisionRouter.get('/process-revisions', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, src_id } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (src_type) { where += ' AND r.src_type = ?'; params.push(src_type); }
  if (src_id) { where += ' AND r.src_id = ?'; params.push(src_id); }

  const rows = await query(
    `SELECT r.id, r.src_type, r.src_id, r.revision_no, r.revision_date, r.reason,
            r.status_before, r.status_after, r.changes_json, r.created_at,
            u.full_name AS revised_by
       FROM trx_process_revision r
       LEFT JOIN mst_user u ON u.id = r.created_by
       ${where}
      ORDER BY r.src_type, r.src_id, r.revision_no DESC
      LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

/** GET /process-revisions/:id — one revision including its full snapshot. */
revisionRouter.get('/process-revisions/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const row = await queryOne(
    `SELECT r.*, u.full_name AS revised_by
       FROM trx_process_revision r
       LEFT JOIN mst_user u ON u.id = r.created_by
      WHERE r.id = ? AND r.company_id = ?`, [req.params.id, cid]);
  if (!row) throw NotFound('Revision not found');
  res.json({ success: true, data: row });
}));

/** GET /process-revisions/fields/:srcType — what a revision may change. */
revisionRouter.get('/process-revisions/fields/:srcType', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const t = String(req.params.srcType).toUpperCase() as SrcType;
  if (!SRC[t]) throw BadRequest('Unknown document type');
  res.json({ success: true, data: REVISABLE[t] });
}));

export default revisionRouter;
