import { query, queryOne, txQueryOne, txExecute, type Tx } from '../config/db.js';
import { BadRequest } from './errors.js';

/**
 * Controls shared by the process DCs and inwards (client voice note 02-Oct-2026):
 *   • a process DC goes out only against an ACCEPTED process quotation of the vendor (its rate is
 *     the job-work rate the bill is checked against) — company setting PROCESS_QUOTATION_REQUIRED;
 *   • every inward is mapped to its gate entry — GATE_ENTRY_REQUIRED_FOR_INWARD.
 */
export async function settingFlag(cid: number, key: string, dflt = false): Promise<boolean> {
  const r = await queryOne<any>('SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?', [cid, key]);
  if (!r) return dflt;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(r.v).trim().toLowerCase());
}

const n = (v: unknown) => Number(v ?? 0) || 0;

/** The job a quotation (or one of its lines) is made for — '' when it is a general rate. */
const jobKey = (v: unknown) => String(v ?? '').trim().toUpperCase();
function quoteJobs(q: any, lines: any[]) {
  const jobs = new Set<string>();
  if (jobKey(q.job_no)) jobs.add(jobKey(q.job_no));
  lines.forEach((l) => { if (jobKey(l.job_no)) jobs.add(jobKey(l.job_no)); if (l.so_id) jobs.add(`SO:${l.so_id}`); });
  return jobs;
}
const lineForJob = (l: any, job?: { io_no?: string | null; so_id?: number | null }) =>
  !!job && ((!!jobKey(l.job_no) && jobKey(l.job_no) === jobKey(job.io_no)) || (!!l.so_id && !!job.so_id && Number(l.so_id) === Number(job.so_id)));

/**
 * Accepted process quotations of a vendor (optionally for a material / process), with their line rates.
 * With a job (io_no / so_id): quotations made for that job come first (job_match), general ones follow,
 * quotations made only for other jobs are left out; the job's own rate lines are listed first.
 */
export async function processQuotations(cid: number, f: { vendor_id: number; material?: string | null; process?: string | null; on?: string | null; io_no?: string | null; so_id?: number | null }) {
  const rows = await query<any>(
    `SELECT q.id, q.quotation_no, q.version, q.quotation_date, q.valid_until, q.quotation_type, q.process_name, q.job_no, q.supplier_id, p.party_name AS supplier_name, s.code AS status
       FROM trx_quotation q JOIN cfg_status s ON s.id = q.status_id LEFT JOIN mst_party p ON p.id = q.supplier_id
      WHERE q.company_id = ? AND q.supplier_id = ? AND q.quotation_category = 'PROCESS' AND s.code = 'ACCEPTED' AND COALESCE(q.is_deleted, 0) = 0
        AND (q.valid_until IS NULL OR q.valid_until >= COALESCE(?, CURDATE()))
      ORDER BY q.quotation_date DESC, q.id DESC`, [cid, f.vendor_id, f.on ?? null]);
  if (!rows.length) return [];
  const lines = await query<any>(
    `SELECT l.id, l.quotation_id, l.material_type, l.description, l.fabric_id, l.yarn_id, l.job_no, l.so_id, fb.fabric_name, y.yarn_name, u.code AS uom_code,
            mc.color_name, COALESCE(NULLIF(l.confirm_rate, 0), NULLIF(l.quotation_rate, 0), l.unit_price) AS rate
       FROM trx_quotation_line l LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_color mc ON mc.id = l.color_id
      WHERE l.quotation_id IN (?) ORDER BY l.sort_order, l.id`, [rows.map((r) => r.id)]);
  const mat = (f.material ?? '').toUpperCase();
  const proc = (f.process ?? '').toLowerCase().replace(/[_-]/g, ' ').replace(/^re /, '');
  const job = f.io_no || f.so_id ? { io_no: f.io_no ?? null, so_id: f.so_id ?? null } : undefined;
  return rows
    .map((q) => {
      const ls = lines.filter((l) => Number(l.quotation_id) === Number(q.id)).map((l) => ({ ...l, rate: n(l.rate), job_match: lineForJob(l, job) }));
      const jobs = quoteJobs(q, ls);
      const match = !!job && (jobs.has(jobKey(job.io_no)) || (!!job.so_id && jobs.has(`SO:${job.so_id}`)));
      // a job-wise quotation: only the job's own lines (plus lines with no job) apply to this job
      const usable = job && jobs.size ? ls.filter((l) => l.job_match || (!jobKey(l.job_no) && !l.so_id)) : ls;
      return { ...q, job_match: match, job_wise: jobs.size > 0, lines: usable.sort((a, b) => Number(b.job_match) - Number(a.job_match)) };
    })
    .filter((q) => !job || !q.job_wise || q.job_match)
    .filter((q) => !mat || !q.quotation_type || q.quotation_type === mat || q.quotation_type === 'GENERAL' || (mat === 'TRIM' && q.quotation_type === 'TRIMS'))
    // best match first: the quotation's process name contains the process word
    .sort((a, b) => Number(b.job_match) - Number(a.job_match) || Number(!!proc && String(b.process_name ?? '').toLowerCase().includes(proc.split(' ').pop()!)) - Number(!!proc && String(a.process_name ?? '').toLowerCase().includes(proc.split(' ').pop()!)));
}

/**
 * Checks the quotation picked on a process DC: accepted, of this vendor, process category.
 * Returns { quotation_id, quotation_line_id, rate } — or nulls when no quotation is required and none was picked.
 */
export async function checkDcQuotation(cid: number, m: { vendor_id: number; quotation_id?: number | null; quotation_line_id?: number | null; rate?: number | null; label: string; required?: boolean;
  /** The job the DC line is for — a quotation made for another job is refused. */
  job?: { io_no?: string | null; so_id?: number | null } }) {
  const required = m.required ?? await settingFlag(cid, 'PROCESS_QUOTATION_REQUIRED', false);
  if (!m.quotation_id) {
    if (required) throw BadRequest(`${m.label}: pick the vendor's approved process quotation (the job-work rate) — create / accept the process quotation first`);
    return { quotation_id: null, quotation_line_id: null, rate: m.rate ?? null };
  }
  const q = await queryOne<any>(
    `SELECT q.id, q.quotation_no, q.supplier_id, q.quotation_category, q.valid_until, q.job_no, s.code AS status FROM trx_quotation q JOIN cfg_status s ON s.id = q.status_id
      WHERE q.id = ? AND q.company_id = ?`, [m.quotation_id, cid]);
  if (!q) throw BadRequest(`${m.label}: quotation not found`);
  if (q.quotation_category !== 'PROCESS') throw BadRequest(`${m.label}: ${q.quotation_no} is not a process (job-work) quotation`);
  if (Number(q.supplier_id) !== Number(m.vendor_id)) throw BadRequest(`${m.label}: ${q.quotation_no} is another vendor's quotation`);
  if (q.status !== 'ACCEPTED') throw BadRequest(`${m.label}: ${q.quotation_no} is not approved (status ${String(q.status).toLowerCase()})`);
  if (m.job) {
    const qls = await query<any>('SELECT id, job_no, so_id FROM trx_quotation_line WHERE quotation_id = ?', [q.id]);
    const jobs = quoteJobs(q, qls);
    const mine = jobs.has(jobKey(m.job.io_no)) || (!!m.job.so_id && jobs.has(`SO:${m.job.so_id}`));
    if (jobs.size && !mine) throw BadRequest(`${m.label}: ${q.quotation_no} is made for job ${[...jobs].map((j) => j.replace(/^SO:/, 'order #')).join(', ')}, not ${m.job.io_no ?? 'this job'}`);
    if (m.quotation_line_id) {
      const ql = qls.find((x) => Number(x.id) === Number(m.quotation_line_id));
      if (ql && (jobKey(ql.job_no) || ql.so_id) && !lineForJob(ql, m.job)) throw BadRequest(`${m.label}: that rate line of ${q.quotation_no} is for another job`);
    }
  }
  let rate = m.rate ?? null;
  if (m.quotation_line_id) {
    const l = await queryOne<any>(`SELECT COALESCE(NULLIF(confirm_rate, 0), NULLIF(quotation_rate, 0), unit_price) AS rate FROM trx_quotation_line WHERE id = ? AND quotation_id = ?`, [m.quotation_line_id, q.id]);
    if (!l) throw BadRequest(`${m.label}: the rate line is not on ${q.quotation_no}`);
    rate = n(l.rate);
  } else if (rate == null) {
    // no line picked: the job's own rate line first, then a general line
    const ls = await query<any>(`SELECT id, job_no, so_id, COALESCE(NULLIF(confirm_rate, 0), NULLIF(quotation_rate, 0), unit_price) AS rate FROM trx_quotation_line WHERE quotation_id = ? ORDER BY sort_order, id`, [q.id]);
    const l = (m.job ? ls.find((x) => lineForJob(x, m.job)) : null) ?? ls.find((x) => !jobKey(x.job_no) && !x.so_id) ?? ls[0];
    rate = l ? n(l.rate) : null;
    return { quotation_id: Number(q.id), quotation_line_id: l ? Number(l.id) : null, rate };
  }
  return { quotation_id: Number(q.id), quotation_line_id: m.quotation_line_id ?? null, rate };
}

/** Open gate entries of a party (for the inward screens' gate entry picker). */
export async function openGateEntries(cid: number, partyId?: number | null) {
  return query<any>(
    `SELECT g.id, g.entry_no, g.entry_date, g.entry_time, g.party_id, p.party_name, g.vehicle_no, g.supplier_dc_no, g.supplier_inv_no, g.material_type,
            g.package_count, g.net_weight_kg, g.status, g.ref_no
       FROM trx_gate_inward g LEFT JOIN mst_party p ON p.id = g.party_id
      WHERE g.company_id = ? ${partyId ? 'AND g.party_id = ?' : ''} AND g.status NOT IN ('REJECTED','CANCELLED') AND g.entry_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
      ORDER BY g.id DESC LIMIT 200`, partyId ? [cid, partyId] : [cid]);
}

/**
 * Validates the gate entry of an inward (same party, not rejected / cancelled) and marks it GRN_COMPLETED.
 * One gate entry may cover several documents brought in the same vehicle.
 */
export async function useGateEntry(tx: Tx, cid: number, m: { gate_inward_id?: number | null; party_id?: number | null; label: string }) {
  if (!m.gate_inward_id) {
    if (await settingFlag(cid, 'GATE_ENTRY_REQUIRED_FOR_INWARD', false)) throw BadRequest(`${m.label}: map the gate entry of this inward (security gate entry is required)`);
    return null;
  }
  const g = await txQueryOne<any>(tx, 'SELECT * FROM trx_gate_inward WHERE id = ? AND company_id = ? FOR UPDATE', [m.gate_inward_id, cid]);
  if (!g) throw BadRequest(`${m.label}: gate entry not found`);
  if (['REJECTED', 'CANCELLED'].includes(g.status)) throw BadRequest(`${m.label}: gate entry ${g.entry_no} is ${String(g.status).toLowerCase()}`);
  if (m.party_id && g.party_id && Number(g.party_id) !== Number(m.party_id)) throw BadRequest(`${m.label}: gate entry ${g.entry_no} is of another party`);
  if (g.status !== 'GRN_COMPLETED') await txExecute(tx, `UPDATE trx_gate_inward SET status = 'GRN_COMPLETED' WHERE id = ?`, [g.id]);
  return g;
}
