import { query } from '../config/db.js';

/**
 * Rate of a material for BOM costing (client 03-Oct-2026: the BOM showed no yarn cost because a yarn count variant
 * created from the BOM has no standard rate). Order of preference:
 *   1. the item master's standard rate (std_rate > 0)
 *   2. the latest ACCEPTED purchase quotation of the item (confirm rate, else quotation rate) — not job-work quotations
 *   3. the latest purchase order rate of the item
 * Each rate carries its source so the screen can say where it came from (or that there is none).
 */
export type MatType = 'YARN' | 'FABRIC' | 'TRIM';
export interface MatRate { rate: number; source: 'STD' | 'QUOTATION' | 'PO' | 'NONE'; ref: string | null }
const COL: Record<MatType, string> = { YARN: 'yarn_id', FABRIC: 'fabric_id', TRIM: 'trim_id' };
const MST: Record<MatType, string> = { YARN: 'mst_yarn', FABRIC: 'mst_fabric', TRIM: 'mst_trim' };

export async function materialRates(cid: number, items: { type: MatType; id: number }[]): Promise<Map<string, MatRate>> {
  const out = new Map<string, MatRate>();
  for (const t of ['YARN', 'FABRIC', 'TRIM'] as MatType[]) {
    const ids = [...new Set(items.filter((i) => i.type === t && i.id).map((i) => Number(i.id)))];
    if (!ids.length) continue;
    const std = await query<any>(`SELECT id, std_rate FROM ${MST[t]} WHERE id IN (?)`, [ids]);
    const need = ids.filter((id) => !(Number(std.find((s) => Number(s.id) === id)?.std_rate) > 0));
    std.forEach((s) => { if (Number(s.std_rate) > 0) out.set(`${t}:${s.id}`, { rate: Number(s.std_rate), source: 'STD', ref: null }); });
    if (!need.length) continue;
    const qs = await query<any>(
      `SELECT l.${COL[t]} AS mid, q.quotation_no, COALESCE(NULLIF(l.confirm_rate, 0), NULLIF(l.quotation_rate, 0), NULLIF(l.unit_price, 0)) AS rate
         FROM trx_quotation_line l JOIN trx_quotation q ON q.id = l.quotation_id JOIN cfg_status s ON s.id = q.status_id
        WHERE q.company_id = ? AND l.${COL[t]} IN (?) AND s.code = 'ACCEPTED' AND COALESCE(q.is_deleted, 0) = 0
          AND COALESCE(q.quotation_category, 'PURCHASE') <> 'PROCESS'
          AND COALESCE(NULLIF(l.confirm_rate, 0), NULLIF(l.quotation_rate, 0), NULLIF(l.unit_price, 0)) > 0
        ORDER BY q.quotation_date DESC, q.id DESC`, [cid, need]);
    for (const id of need) {
      const q = qs.find((x) => Number(x.mid) === id);
      if (q) out.set(`${t}:${id}`, { rate: Number(q.rate), source: 'QUOTATION', ref: q.quotation_no });
    }
    const still = need.filter((id) => !out.has(`${t}:${id}`));
    if (!still.length) continue;
    const pos = await query<any>(
      `SELECT pl.${COL[t]} AS mid, po.po_no, pl.rate FROM trx_purchase_order_line pl JOIN trx_purchase_order po ON po.id = pl.po_id
        WHERE po.company_id = ? AND pl.${COL[t]} IN (?) AND COALESCE(po.is_deleted, 0) = 0 AND pl.rate > 0
          AND COALESCE(po.approval_state, '') NOT IN ('CANCELLED', 'REJECTED')
        ORDER BY po.po_date DESC, po.id DESC`, [cid, still]);
    for (const id of still) {
      const p = pos.find((x) => Number(x.mid) === id);
      out.set(`${t}:${id}`, p ? { rate: Number(p.rate), source: 'PO', ref: p.po_no } : { rate: 0, source: 'NONE', ref: null });
    }
  }
  return out;
}

/** BOM line rows (with std_rate) → std_rate filled by the fallback, plus rate_source / rate_ref. */
export async function withMaterialRates<T extends Record<string, any>>(cid: number, rows: T[]): Promise<T[]> {
  const key = (l: any): { type: MatType; id: number } | null => (l.material_type === 'YARN' && l.yarn_id ? { type: 'YARN', id: Number(l.yarn_id) }
    : l.material_type === 'FABRIC' && l.fabric_id ? { type: 'FABRIC', id: Number(l.fabric_id) }
      : l.trim_id ? { type: 'TRIM', id: Number(l.trim_id) } : null);
  const rates = await materialRates(cid, rows.map(key).filter(Boolean) as { type: MatType; id: number }[]);
  return rows.map((l) => {
    const k = key(l); const r = k ? rates.get(`${k.type}:${k.id}`) : undefined;
    return { ...l, std_rate: r?.rate ?? Number(l.std_rate ?? 0), rate_source: r?.source ?? 'NONE', rate_ref: r?.ref ?? null };
  });
}
