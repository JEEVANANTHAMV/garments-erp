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

/** Accepted process quotations of a vendor (optionally for a material / process), with their line rates. */
export async function processQuotations(cid: number, f: { vendor_id: number; material?: string | null; process?: string | null; on?: string | null }) {
  const rows = await query<any>(
    `SELECT q.id, q.quotation_no, q.version, q.quotation_date, q.valid_until, q.quotation_type, q.process_name, q.supplier_id, p.party_name AS supplier_name, s.code AS status
       FROM trx_quotation q JOIN cfg_status s ON s.id = q.status_id LEFT JOIN mst_party p ON p.id = q.supplier_id
      WHERE q.company_id = ? AND q.supplier_id = ? AND q.quotation_category = 'PROCESS' AND s.code = 'ACCEPTED' AND COALESCE(q.is_deleted, 0) = 0
        AND (q.valid_until IS NULL OR q.valid_until >= COALESCE(?, CURDATE()))
      ORDER BY q.quotation_date DESC, q.id DESC`, [cid, f.vendor_id, f.on ?? null]);
  if (!rows.length) return [];
  const lines = await query<any>(
    `SELECT l.id, l.quotation_id, l.material_type, l.description, l.fabric_id, l.yarn_id, fb.fabric_name, y.yarn_name, u.code AS uom_code,
            COALESCE(NULLIF(l.confirm_rate, 0), NULLIF(l.quotation_rate, 0), l.unit_price) AS rate
       FROM trx_quotation_line l LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN cfg_uom u ON u.id = l.uom_id
      WHERE l.quotation_id IN (?) ORDER BY l.sort_order, l.id`, [rows.map((r) => r.id)]);
  const mat = (f.material ?? '').toUpperCase();
  const proc = (f.process ?? '').toLowerCase().replace(/[_-]/g, ' ').replace(/^re /, '');
  return rows
    .map((q) => ({ ...q, lines: lines.filter((l) => Number(l.quotation_id) === Number(q.id)).map((l) => ({ ...l, rate: n(l.rate) })) }))
    .filter((q) => !mat || !q.quotation_type || q.quotation_type === mat || q.quotation_type === 'GENERAL' || (mat === 'TRIM' && q.quotation_type === 'TRIMS'))
    // best match first: the quotation's process name contains the process word
    .sort((a, b) => Number(!!proc && String(b.process_name ?? '').toLowerCase().includes(proc.split(' ').pop()!)) - Number(!!proc && String(a.process_name ?? '').toLowerCase().includes(proc.split(' ').pop()!)));
}

/**
 * Checks the quotation picked on a process DC: accepted, of this vendor, process category.
 * Returns { quotation_id, quotation_line_id, rate } — or nulls when no quotation is required and none was picked.
 */
export async function checkDcQuotation(cid: number, m: { vendor_id: number; quotation_id?: number | null; quotation_line_id?: number | null; rate?: number | null; label: string; required?: boolean }) {
  const required = m.required ?? await settingFlag(cid, 'PROCESS_QUOTATION_REQUIRED', false);
  if (!m.quotation_id) {
    if (required) throw BadRequest(`${m.label}: pick the vendor's approved process quotation (the job-work rate) — create / accept the process quotation first`);
    return { quotation_id: null, quotation_line_id: null, rate: m.rate ?? null };
  }
  const q = await queryOne<any>(
    `SELECT q.id, q.quotation_no, q.supplier_id, q.quotation_category, q.valid_until, s.code AS status FROM trx_quotation q JOIN cfg_status s ON s.id = q.status_id
      WHERE q.id = ? AND q.company_id = ?`, [m.quotation_id, cid]);
  if (!q) throw BadRequest(`${m.label}: quotation not found`);
  if (q.quotation_category !== 'PROCESS') throw BadRequest(`${m.label}: ${q.quotation_no} is not a process (job-work) quotation`);
  if (Number(q.supplier_id) !== Number(m.vendor_id)) throw BadRequest(`${m.label}: ${q.quotation_no} is another vendor's quotation`);
  if (q.status !== 'ACCEPTED') throw BadRequest(`${m.label}: ${q.quotation_no} is not approved (status ${String(q.status).toLowerCase()})`);
  let rate = m.rate ?? null;
  if (m.quotation_line_id) {
    const l = await queryOne<any>(`SELECT COALESCE(NULLIF(confirm_rate, 0), NULLIF(quotation_rate, 0), unit_price) AS rate FROM trx_quotation_line WHERE id = ? AND quotation_id = ?`, [m.quotation_line_id, q.id]);
    if (!l) throw BadRequest(`${m.label}: the rate line is not on ${q.quotation_no}`);
    rate = n(l.rate);
  } else if (rate == null) {
    const l = await queryOne<any>(`SELECT COALESCE(NULLIF(confirm_rate, 0), NULLIF(quotation_rate, 0), unit_price) AS rate FROM trx_quotation_line WHERE quotation_id = ? ORDER BY sort_order, id LIMIT 1`, [q.id]);
    rate = l ? n(l.rate) : null;
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
