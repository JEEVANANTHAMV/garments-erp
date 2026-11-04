import { queryOne, txExecute, txQuery, txQueryOne, type Tx } from '../../config/db.js';

/**
 * Snapshots printed on a knitting yarn issue DC (C-ONE ERP spec §8–§9): the job no, the yarn and
 * fabric descriptions and the contractor's name / address are copied onto the DC when it is saved,
 * so later master edits never change a DC already given to the knitter.
 */

const clean = (v: unknown) => String(v ?? '').trim();

/** "30s Combed Cotton (Cora / Raw)" — yarn name with the program line's colour. */
export async function yarnDescription(yarnId: number, programYarnId?: number | null): Promise<string> {
  const y = await queryOne<any>('SELECT yarn_code, yarn_name FROM mst_yarn WHERE id = ?', [yarnId]);
  const py = programYarnId ? await queryOne<any>('SELECT colour FROM trx_knitting_program_yarns WHERE id = ?', [programYarnId]) : null;
  const name = clean(y?.yarn_name) || clean(y?.yarn_code) || 'Yarn';
  return py?.colour && clean(py.colour) ? `${name} (${clean(py.colour)})` : name;
}

/** "Single Jersey – 180 GSM / 30" Dia / 24 G" from the knitting program (the job's fabric). */
export function fabricDescriptionOf(p: { fabric_type?: string | null; fabric_name?: string | null; gsm?: unknown; dia?: unknown; gauge?: unknown }): string {
  const base = clean(p.fabric_type) || clean(p.fabric_name) || 'Fabric';
  const gsm = clean(p.gsm);
  const parts = [`${base}${gsm ? ` – ${gsm} GSM` : ''}`];
  if (clean(p.dia)) parts.push(`${clean(p.dia)}" Dia`);
  if (clean(p.gauge)) parts.push(`${clean(p.gauge)} G`);
  return parts.join(' / ');
}

/** Job of a knitting program: its IO no (else program no), sales order and default fabric description. */
export async function jobSnapshot(cid: number, programId: number) {
  const p = await queryOne<any>(
    `SELECT kp.id, kp.program_no, kp.io_no, kp.so_id, kp.status, kp.vendor_id, kp.fabric_type, kp.gsm, kp.dia, kp.gauge, f.fabric_name
       FROM trx_knitting_program kp LEFT JOIN mst_fabric f ON f.id = kp.fabric_id WHERE kp.id = ? AND kp.company_id = ?`, [programId, cid]);
  if (!p) return null;
  return { ...p, job_no: clean(p.io_no) || p.program_no, fabric_description: fabricDescriptionOf(p) };
}

/** Contractor name, GSTIN and default (else first active) address as one line. */
export async function contractorSnapshot(cid: number, partyId: number | null) {
  if (!partyId) return { name: null, address: null, gstin: null };
  const p = await queryOne<any>('SELECT id, party_name, gstin FROM mst_party WHERE id = ? AND company_id = ?', [partyId, cid]);
  if (!p) return null;
  const a = await queryOne<any>(
    `SELECT address_line1, address_line2, address_line3, city, state, pincode FROM mst_party_address
      WHERE party_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1`, [partyId]);
  const addr = a ? [a.address_line1, a.address_line2, a.address_line3, a.city, a.state, a.pincode].map(clean).filter(Boolean).join(', ') : '';
  return { name: p.party_name as string, address: addr || null, gstin: (p.gstin as string | null) ?? null };
}

/**
 * Snapshot rows for stock issues of a DC that have no DC line yet (DCs saved by the one-step
 * "Save & Print" knitting DC): job no, yarn / fabric description, lot, cones, net KG.
 */
export async function backfillDcLines(tx: Tx, cid: number, dcNo: string) {
  const hdr = await txQueryOne<any>(tx, 'SELECT id FROM trx_knitting_dc WHERE company_id = ? AND dc_no = ?', [cid, dcNo]);
  if (!hdr) return;
  // read on the transaction: the issues were just inserted by it
  const rows = await txQuery<any>(tx,
    `SELECT i.* FROM trx_process_issue i WHERE i.company_id = ? AND i.dc_no = ? AND i.src_type = 'KNITTING_PROGRAM' ORDER BY i.id`, [cid, dcNo]);
  let lineNo = Number((await txQueryOne<any>(tx, 'SELECT COALESCE(MAX(line_no), 0) n FROM trx_knitting_dc_line WHERE dc_id = ?', [hdr.id]))?.n ?? 0);
  for (const i of rows) {
    const has = await txQueryOne<any>(tx, 'SELECT id FROM trx_knitting_dc_line WHERE process_issue_id = ?', [i.id]);
    if (has) continue;
    const job = await jobSnapshot(cid, Number(i.src_id));
    const lot = i.lot_no || (i.grn_line_id ? (await txQueryOne<any>(tx, 'SELECT lot_no FROM trx_grn_line WHERE id = ?', [i.grn_line_id]))?.lot_no : null) || null;
    await txExecute(tx,
      `INSERT INTO trx_knitting_dc_line (company_id, dc_id, dc_no, line_no, program_id, program_yarn_id, so_id, job_no_snapshot, yarn_id, grn_line_id, lot_no,
         yarn_description_snapshot, fabric_description_snapshot, cones, net_weight_kg, process_issue_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, hdr.id, dcNo, ++lineNo, i.src_id, i.src_line_id ?? null, i.so_id ?? job?.so_id ?? null, clean(i.io_no) || job?.job_no || null, i.yarn_id, i.grn_line_id ?? null, lot,
       await yarnDescription(Number(i.yarn_id), i.src_line_id ? Number(i.src_line_id) : null), job?.fabric_description ?? null,
       Number(i.no_of_cones) || 0, Number(i.issued_qty_kg) || 0, i.id]);
  }
}

/** Old / new JSON for the DC audit trail. */
export async function dcAudit(tx: Tx, m: { cid: number; dcId: number; dcNo: string; action: string; old?: unknown; new?: unknown; uid: number | null; remarks?: string | null }) {
  await txExecute(tx,
    `INSERT INTO trx_knitting_dc_audit (company_id, dc_id, dc_no, action, old_values_json, new_values_json, user_id, remarks) VALUES (?,?,?,?,?,?,?,?)`,
    [m.cid, m.dcId, m.dcNo, m.action, m.old === undefined ? null : JSON.stringify(m.old), m.new === undefined ? null : JSON.stringify(m.new), m.uid, m.remarks ?? null]);
}
