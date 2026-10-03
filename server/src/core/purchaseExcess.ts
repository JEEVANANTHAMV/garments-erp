import { query, txQuery, type Tx } from '../config/db.js';
import { BadRequest } from './errors.js';
import { jobBomRequirement } from '../modules/bom/bom.routes.js';

/**
 * Purchase excess limit per job (client voice note 03-Oct-2026).
 *
 * A job may buy each BOM material up to  requirement × (1 + excess %) + excess qty  — the excess covers bag /
 * cone / roll round-off. The % and qty come from the job's own allowance (trx_job_purchase_allowance), else the
 * company defaults PURCHASE_EXCESS_{YARN|FABRIC|TRIM}_{PCT|QTY}. "Ordered" = every live PO line of the job for the
 * item (fabric / yarn / general POs and trim POs). PURCHASE_EXCESS_CONTROL = BLOCK / WARN / OFF.
 *
 * Checked per material item (yarn_id / fabric_id / trim_id) in the BOM's UOM; a PO line in another UOM, or for an
 * item that is not on the job's BOM, is reported but never blocked.
 */
export type ExcessGroup = 'YARN' | 'FABRIC' | 'TRIM';
const GROUP: Record<string, ExcessGroup> = { YARN: 'YARN', FABRIC: 'FABRIC', TRIM: 'TRIM', ACCESSORY: 'TRIM', PACKING: 'TRIM', GENERAL: 'TRIM' };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function excessSettings(cid: number) {
  const rows = await query<any>(`SELECT setting_key k, setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key LIKE 'PURCHASE_EXCESS_%'`, [cid]);
  const v = (k: string, d: string) => String(rows.find((r) => r.k === k)?.v ?? d).trim();
  const num = (k: string) => { const x = Number(v(k, '0')); return Number.isFinite(x) && x >= 0 ? x : 0; };
  const mode = v('PURCHASE_EXCESS_CONTROL', 'BLOCK').toUpperCase();
  return {
    control: (['BLOCK', 'WARN', 'OFF'].includes(mode) ? mode : 'BLOCK') as 'BLOCK' | 'WARN' | 'OFF',
    defaults: {
      YARN: { pct: num('PURCHASE_EXCESS_YARN_PCT'), qty: num('PURCHASE_EXCESS_YARN_QTY') },
      FABRIC: { pct: num('PURCHASE_EXCESS_FABRIC_PCT'), qty: num('PURCHASE_EXCESS_FABRIC_QTY') },
      TRIM: { pct: num('PURCHASE_EXCESS_TRIM_PCT'), qty: num('PURCHASE_EXCESS_TRIM_QTY') },
    } as Record<ExcessGroup, { pct: number; qty: number }>,
  };
}

/** The allowance that applies to a job: its own row per material group, else the company default. */
export async function jobAllowances(cid: number, soId: number) {
  const st = await excessSettings(cid);
  const own = await query<any>('SELECT material_type, excess_pct, excess_qty, remarks FROM trx_job_purchase_allowance WHERE company_id = ? AND so_id = ?', [cid, soId]);
  const out = {} as Record<ExcessGroup, { pct: number; qty: number; source: 'JOB' | 'DEFAULT'; remarks: string | null }>;
  for (const g of ['YARN', 'FABRIC', 'TRIM'] as ExcessGroup[]) {
    const o = own.find((x) => x.material_type === g);
    out[g] = o ? { pct: Number(o.excess_pct), qty: Number(o.excess_qty), source: 'JOB', remarks: o.remarks } : { ...st.defaults[g], source: 'DEFAULT', remarks: null };
  }
  return { control: st.control, allowances: out };
}

const itemKey = (mt: string, l: any) => (GROUP[mt] === 'YARN' ? (l.yarn_id ? `Y:${l.yarn_id}` : null) : GROUP[mt] === 'FABRIC' ? (l.fabric_id ? `F:${l.fabric_id}` : null) : (l.trim_id ? `T:${l.trim_id}` : null));

/**
 * Per BOM item of the job: requirement, ordered (all live POs), allowed, and how far over. `tx` reads the POs inside
 * the saving transaction (so the PO being saved counts).
 */
export async function jobPurchaseStatus(cid: number, soId: number, tx?: Tx) {
  let req: any;
  try { req = await jobBomRequirement(cid, { so_id: soId }); } catch { req = null; }   // no BOM yet → nothing to hold to
  const { control, allowances } = await jobAllowances(cid, soId);
  const items = new Map<string, any>();
  for (const l of req?.lines ?? []) {
    const k = itemKey(l.material_type, l);
    if (!k) continue;
    const it = items.get(k) ?? { key: k, group: GROUP[l.material_type], material_type: l.material_type, item_id: Number(l.yarn_id || l.fabric_id || l.trim_id),
      name: l.material_name, uom_id: l.uom_id ? Number(l.uom_id) : null, uom_code: l.uom_code ?? null, required: 0 };
    it.required += Number(l.final_requirement) || 0;
    items.set(k, it);
  }
  const q = <T = any>(sql: string, p: unknown[]) => (tx ? txQuery<T>(tx, sql, p) : query<T>(sql, p));
  const po = await q<any>(
    `SELECT pl.material_type, pl.yarn_id, pl.fabric_id, pl.trim_id, pl.uom_id, SUM(pl.qty) qty, GROUP_CONCAT(DISTINCT p.po_no) pos
       FROM trx_purchase_order_line pl JOIN trx_purchase_order p ON p.id = pl.po_id
      WHERE p.company_id = ? AND COALESCE(pl.so_id, p.so_id) = ? AND COALESCE(p.is_deleted, 0) = 0
        AND COALESCE(p.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'REJECTED')
      GROUP BY pl.material_type, pl.yarn_id, pl.fabric_id, pl.trim_id, pl.uom_id`, [cid, soId]);
  const tpo = await q<any>(
    `SELECT 'TRIM' material_type, NULL yarn_id, NULL fabric_id, tl.trim_id, tl.uom_id, SUM(tl.order_qty) qty, GROUP_CONCAT(DISTINCT t.po_no) pos
       FROM trx_trim_po_line tl JOIN trx_trim_po t ON t.id = tl.po_id
      WHERE t.company_id = ? AND COALESCE(t.status, '') NOT IN ('CANCELLED') AND (tl.so_id = ? OR (tl.so_id IS NULL AND t.io_no = (SELECT COALESCE(io_no, so_no) FROM trx_sales_order WHERE id = ?)))
      GROUP BY tl.trim_id, tl.uom_id`, [cid, soId, soId]).catch(() => []);
  const notes: string[] = [];
  for (const r of [...po, ...tpo]) {
    const k = itemKey(r.material_type, r);
    if (!k) continue;
    const it = items.get(k);
    if (!it) { notes.push(`${r.material_type} #${r.yarn_id || r.fabric_id || r.trim_id} on ${r.pos} is not on the job's BOM`); continue; }
    if (it.uom_id && r.uom_id && Number(r.uom_id) !== it.uom_id) { it.other_uom = true; notes.push(`${it.name}: ${r.pos} is in another UOM than the BOM — not counted`); continue; }
    it.ordered = (it.ordered ?? 0) + Number(r.qty);
    it.pos = [it.pos, r.pos].filter(Boolean).join(', ');
  }
  const rows = [...items.values()].map((it) => {
    const a = allowances[it.group as ExcessGroup];
    const allowed = r3(it.required * (1 + a.pct / 100) + a.qty);
    const ordered = r3(it.ordered ?? 0);
    return { ...it, required: r3(it.required), ordered, allowed, excess_pct: a.pct, excess_qty: a.qty, allowance_source: a.source,
      balance: r3(allowed - ordered), over: ordered > allowed + 0.0005 ? r3(ordered - allowed) : 0 };
  });
  return { so_id: soId, job_no: req?.job_no ?? null, control, allowances, rows, notes, has_bom: !!req };
}

/**
 * After a PO is written (inside its transaction): every job it touches is checked. BLOCK refuses with the
 * item, requirement, allowed and ordered figures; WARN returns the warnings for the response.
 */
export async function assertPurchaseExcess(tx: Tx, cid: number, soIds: (number | null | undefined)[], items?: Set<string>) {
  const jobs = [...new Set(soIds.filter((x): x is number => !!x).map(Number))];
  const warnings: string[] = [];
  for (const so of jobs) {
    const st = await jobPurchaseStatus(cid, so, tx);
    if (st.control === 'OFF') continue;
    const over = st.rows.filter((r) => r.over > 0 && (!items || items.has(r.key)));
    if (!over.length) continue;
    const msg = over.map((r) => `${r.name}: requirement ${r.required} ${r.uom_code ?? ''} + allowance (${r.excess_pct}%${r.excess_qty ? ` + ${r.excess_qty}` : ''}) = ${r.allowed}, ordered on POs ${r.ordered} — ${r.over} over`).join('; ');
    if (st.control === 'BLOCK') throw BadRequest(`Job ${st.job_no ?? so}: purchase above the allowed excess — ${msg}. Reduce the qty, or raise the job's excess allowance (Purchase Excess Limits)`);
    warnings.push(`Job ${st.job_no ?? so}: ${msg}`);
  }
  return warnings;
}

/** Keys (Y:/F:/T:) of the items on a set of PO lines — only those are checked when a PO is saved. */
export const poItemKeys = (lines: any[]) => new Set(lines.map((l) => itemKey(l.material_type ?? 'TRIM', l)).filter((x): x is string => !!x));

/** Same check for a PO already written in `tx`, read back by id (quotation → PO, MRP → PO, trim POs). */
export async function assertPoExcessById(tx: Tx, cid: number, poId: number, kind: 'PO' | 'TRIM_PO' = 'PO') {
  const lines = kind === 'PO'
    ? await txQuery<any>(tx, `SELECT COALESCE(pl.so_id, p.so_id) so_id, pl.material_type, pl.yarn_id, pl.fabric_id, pl.trim_id, p.approval_state st
                               FROM trx_purchase_order_line pl JOIN trx_purchase_order p ON p.id = pl.po_id WHERE p.id = ?`, [poId])
    : await txQuery<any>(tx, `SELECT COALESCE(tl.so_id, (SELECT so.id FROM trx_sales_order so WHERE so.company_id = t.company_id AND so.is_deleted = 0 AND (so.io_no = t.io_no OR so.so_no = t.io_no) ORDER BY so.id DESC LIMIT 1)) so_id,
                                     'TRIM' material_type, NULL yarn_id, NULL fabric_id, tl.trim_id, t.status st
                               FROM trx_trim_po_line tl JOIN trx_trim_po t ON t.id = tl.po_id WHERE t.id = ?`, [poId]);
  if (!lines.length || ['CANCELLED', 'REJECTED'].includes(String(lines[0].st ?? ''))) return [];
  return assertPurchaseExcess(tx, cid, lines.map((l) => l.so_id), poItemKeys(lines));
}
