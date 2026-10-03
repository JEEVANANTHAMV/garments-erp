import type { Request } from 'express';
import { query, queryOne } from '../config/db.js';
import { BadRequest } from './errors.js';

/**
 * Bills Inward (supplier bill) rules — client voice note 03-Oct-2026:
 *  - a purchase bill is made from its GRNs; a direct bill (no GRN) is only for the General bill type
 *  - a GRN is billed once (not on another live supplier bill)
 *  - job-work inward GRNs (knitting / fabric process / yarn process) are billed in their own process bills
 *  - every GRN must be the bill supplier's; a mapped gate entry must be the supplier's and live
 * Bills saved before these rules (direct bills of other types) stay editable as long as they stay direct.
 */
const ids = (v: unknown): number[] => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { x = []; } }
  return Array.isArray(x) ? x.map(Number).filter((n) => n > 0) : [];
};

export async function checkSupplierBill(req: Request, data: Record<string, unknown>, before?: any) {
  const cid = req.user!.companyId;
  const row = { ...(before ?? {}), ...data };
  if (String(row.status ?? '') === 'CANCELLED') return;
  const lines: any[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const grnIds = [...new Set([...ids(row.grn_ids), ...(row.grn_id ? [Number(row.grn_id)] : []), ...lines.map((l) => Number(l.grn_id)).filter((n) => n > 0)])];
  const trimIds = ids(row.trim_grn_ids);
  const type = String(row.bill_type ?? 'GENERAL');
  const wasDirect = before && !ids(before.grn_ids).length && !before.grn_id && !ids(before.trim_grn_ids).length;

  if (type !== 'GENERAL' && !grnIds.length && !trimIds.length && !wasDirect) {
    throw BadRequest('A purchase bill is made from its GRN(s) — pick the GRN(s). A direct bill (without GRN) is only for the General bill type');
  }
  const billId = before?.id ? Number(before.id) : 0;
  const supplierId = Number(row.supplier_id) || null;

  if (grnIds.length) {
    const grns = await query<any>(
      `SELECT g.id, g.grn_no, g.supplier_id,
              (EXISTS (SELECT 1 FROM trx_process_receipt pr WHERE pr.grn_id = g.id) OR EXISTS (SELECT 1 FROM trx_fabric_process_inward i WHERE i.grn_id = g.id)
               OR EXISTS (SELECT 1 FROM trx_yarn_process_inward i WHERE i.grn_id = g.id OR i.reject_grn_id = g.id)) AS job_work,
              (SELECT b.bill_no FROM trx_supplier_bill b WHERE b.company_id = g.company_id AND b.id <> ? AND COALESCE(b.status, '') <> 'CANCELLED'
                  AND (b.grn_id = g.id OR IF(JSON_VALID(b.grn_ids), JSON_CONTAINS(b.grn_ids, CAST(g.id AS JSON)), 0)
                       OR EXISTS (SELECT 1 FROM trx_supplier_bill_line bl WHERE bl.bill_id = b.id AND bl.grn_id = g.id)) LIMIT 1) AS billed_on
         FROM trx_grn g WHERE g.company_id = ? AND g.id IN (?)`, [billId, cid, grnIds]);
    for (const id of grnIds) {
      const g = grns.find((x) => Number(x.id) === id);
      if (!g) throw BadRequest(`GRN #${id} not found`);
      if (Number(g.job_work)) throw BadRequest(`${g.grn_no} is a job-work inward — bill it in its process bill (Knitting / Fabric process / Yarn process bills)`);
      if (g.billed_on) throw BadRequest(`${g.grn_no} is already billed on ${g.billed_on}`);
      if (supplierId && g.supplier_id && Number(g.supplier_id) !== supplierId) throw BadRequest(`${g.grn_no} is of another supplier`);
    }
  }
  if (trimIds.length) {
    const tg = await query<any>(
      `SELECT g.id, g.grn_no, g.supplier_id,
              (SELECT b.bill_no FROM trx_supplier_bill b WHERE b.company_id = g.company_id AND b.id <> ? AND COALESCE(b.status, '') <> 'CANCELLED'
                  AND IF(JSON_VALID(b.trim_grn_ids), JSON_CONTAINS(b.trim_grn_ids, CAST(g.id AS JSON)), 0) LIMIT 1) AS billed_on
         FROM trx_trim_grn g WHERE g.company_id = ? AND g.id IN (?)`, [billId, cid, trimIds]);
    for (const id of trimIds) {
      const g = tg.find((x) => Number(x.id) === id);
      if (!g) throw BadRequest(`Trim GRN #${id} not found`);
      if (g.billed_on) throw BadRequest(`${g.grn_no} is already billed on ${g.billed_on}`);
      if (supplierId && g.supplier_id && Number(g.supplier_id) !== supplierId) throw BadRequest(`${g.grn_no} is of another supplier`);
    }
  }
  if (row.gate_inward_id) {
    const g = await queryOne<any>('SELECT entry_no, party_id, status FROM trx_gate_inward WHERE id = ? AND company_id = ?', [row.gate_inward_id, cid]);
    if (!g) throw BadRequest('Gate entry not found');
    if (['REJECTED', 'CANCELLED'].includes(g.status)) throw BadRequest(`Gate entry ${g.entry_no} is ${String(g.status).toLowerCase()}`);
    if (supplierId && g.party_id && Number(g.party_id) !== supplierId) throw BadRequest(`Gate entry ${g.entry_no} is of another party`);
    data.gate_matched = 1;
  } else if ('gate_inward_id' in data) {
    data.gate_matched = 0;
  }
  if (grnIds.length || trimIds.length) data.grn_matched = 1;
}
