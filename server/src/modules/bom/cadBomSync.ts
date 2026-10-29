import { query, queryOne, txQuery, txExecute, type Tx } from '../../config/db.js';

/**
 * CAD → BOM (client 29-Oct-2026: "CAD shows 612 kg, the BOM comes out different").
 *
 * The CAD's fabric program is the job's fabric requirement: per fabric (type + GSM + dia) the grand total already holds
 * the cut excess, the 2% buffer and the samples; foldings / tapes / cords bought by weight come on top, and the collar
 * yarn. The BOM is per piece and the job requirement multiplies it by the job's PLAN-CUT pieces, so each line is
 *   consumption = CAD kg of that fabric ÷ plan-cut pieces of the CAD's job, wastage 0 %
 * which makes the job requirement exactly the CAD's kg (no second excess, no wastage on top of the CAD's buffers).
 * Yarn = fabric × (1 + knitting loss 5 %) per yarn of the fabrics (the CAD's own yarn rule), plus the collar yarn.
 * Every CAD fabric must exist in the fabric master — no "first fabric" fallback.
 */
export const KNIT_LOSS_PCT = 5;
const r5 = (x: number) => Math.round(x * 100000) / 100000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

export interface CadBomLine {
  material_type: 'FABRIC' | 'YARN';
  fabric_id: number | null; yarn_id: number | null;
  name: string; dia: string | null; gsm: number | null;
  /** KG (knits, yarn) or MTR (woven / foam) — total_kg is in this unit */
  uom: 'KG' | 'MTR';
  /** colour-wise fabric line (the CAD's colour on the job); null = all colours */
  color_id: number | null; color_name: string | null;
  total_kg: number; consumption: number; remarks: string;
}
export interface CadBomPreview {
  cad_req_id: number; req_no: string; cad_version: string; plan_cut_pcs: number; pcs_source: string;
  fabric_kg: number; fabric_mtr: number; yarn_kg: number; lines: CadBomLine[]; problems: string[];
}

type Db = { tx?: Tx };
const run = <T,>(db: Db, sql: string, p: unknown[]) => (db.tx ? txQuery<T>(db.tx, sql, p) : query<T>(sql, p));

/** The fabric master row for a CAD fabric name (+ GSM: "Single Jersey" 160 → "Single Jersey 160 GSM"). */
async function matchFabric(db: Db, cid: number, name: string, gsm: number | null) {
  const want = [norm(name), ...(gsm ? [norm(`${name} ${gsm} GSM`), norm(`${name} ${gsm}GSM`)] : [])];
  const rows = await run<any>(db, `SELECT id, fabric_name, fabric_code, yarn_id FROM mst_fabric WHERE company_id = ? AND is_active = 1 AND COALESCE(is_deleted, 0) = 0`, [cid]);
  for (const w of want) {
    const hit = rows.find((r) => norm(r.fabric_name) === w || norm(r.fabric_code) === w);
    if (hit) return hit;
  }
  return null;
}

/** BOM lines of a CAD requirement (approved or not) for its job. `yarnFallback`: yarn for fabrics whose master has none. */
export async function cadBomPreview(db: Db, cid: number, cadReqId: number, yarnFallback: number | null = null): Promise<CadBomPreview> {
  const cr = (await run<any>(db, `SELECT id, req_no, cad_version, internal_ir_no, style_id, order_qty, data_json FROM trx_cad_requirement WHERE id = ? AND company_id = ?`, [cadReqId, cid]))[0];
  if (!cr) throw new Error('CAD requirement not found');
  let dj: any = cr.data_json;
  try { while (typeof dj === 'string') dj = JSON.parse(dj); } catch { dj = {}; }
  dj = dj ?? {};
  const problems: string[] = [];

  // pieces the job's requirement is worked out on (MRP: plan-cut pieces of the style on the job)
  const pc = (await run<any>(db,
    `SELECT COALESCE(SUM(l.plan_cut_qty), 0) pc, COALESCE(SUM(l.order_qty), 0) q FROM trx_sales_order_line l JOIN trx_sales_order so ON so.id = l.so_id
      WHERE so.company_id = ? AND so.is_deleted = 0 AND (so.io_no = ? OR so.so_no = ?) AND l.style_id = ?`,
    [cid, cr.internal_ir_no, cr.internal_ir_no, cr.style_id]))[0];
  const planCut = Number(pc?.pc) || 0;
  const pcs = planCut > 0 ? planCut : Number(cr.order_qty) || 0;
  const pcsSource = planCut > 0 ? `plan-cut pcs of ${cr.internal_ir_no}` : 'CAD order qty (job has no plan cut)';
  if (!(pcs > 0)) problems.push('The CAD has no order quantity and its job no plan-cut quantity');

  // plan-cut pcs of every colour of the style on the job — a colour-wise fabric line is worked out on its colour's pcs
  const colourRows = await run<any>(db,
    `SELECT k.color_id, c.color_name, SUM(COALESCE(sk.plan_cut_qty, sk.qty)) pc FROM trx_sales_order_sku sk
       JOIN trx_sales_order_line l ON l.id = sk.so_line_id JOIN trx_sales_order so ON so.id = l.so_id
       JOIN mst_style_sku k ON k.id = sk.sku_id JOIN mst_color c ON c.id = k.color_id
      WHERE so.company_id = ? AND so.is_deleted = 0 AND (so.io_no = ? OR so.so_no = ?) AND l.style_id = ?
      GROUP BY k.color_id, c.color_name`, [cid, cr.internal_ir_no, cr.internal_ir_no, cr.style_id]);
  const jobColour = (name: string) => colourRows.find((c) => norm(c.color_name) === norm(name) && Number(c.pc) > 0) ?? null;

  // fabric program per fabric, colour by colour (fabric is knitted / dyed / bought per colour) + parts bought by weight
  const fp = await run<any>(db, `SELECT fabric_type, gsm, dia_val, dia_spec, color_name, grand_total_qty, uom FROM trx_cad_fabric_program WHERE cad_req_id = ? AND sheet_type = 'FABRIC_PROGRAM'`, [cadReqId]);
  const src = fp.length ? fp : (Array.isArray(dj.fabric_program) ? dj.fabric_program : []);
  type Grp = { name: string; gsm: number | null; dia: string | null; kg: number; what: string; uom: 'KG' | 'MTR'; colours: Map<string, number> };
  const groups = new Map<string, Grp>();
  const add = (name: string, gsm: number | null, dia: string | null, kg: number, what: string, uom: 'KG' | 'MTR' = 'KG', colour: string | null = null) => {
    if (!(kg > 0)) return;
    const k = `${norm(name)}|${gsm ?? ''}|${dia ?? ''}|${uom}`;
    const g = groups.get(k) ?? { name, gsm, dia, kg: 0, what, uom, colours: new Map<string, number>() };
    g.kg += kg;
    const ck = colour ? String(colour).trim() : '';
    g.colours.set(ck, (g.colours.get(ck) ?? 0) + kg);
    groups.set(k, g);
  };
  for (const f of src) {
    const uom = String(f.uom ?? 'KG').toUpperCase().startsWith('M') ? 'MTR' : 'KG';   // woven / foam fabric in metres
    const dia = String(f.dia_val ?? f.dia_spec ?? '').replace(/[^0-9.]/g, '') || null;
    add(String(f.fabric_type || 'Main Fabric'), uom === 'KG' ? Number(f.gsm) || null : null, dia, Number(f.grand_total_qty) || 0, 'fabric program', uom, f.color_name ?? null);
  }
  for (const p of Array.isArray(dj.special_parts) ? dj.special_parts : []) {
    const kg = Number(p.total_kg) || (String(p.uom ?? '').toUpperCase().startsWith('KG') ? Number(p.total_qty) || 0 : 0);
    if (!kg) { if (Number(p.total_qty) > 0) problems.push(`${p.part_name}: no weight factor — it cannot go into the BOM in KG`); continue; }
    add(String(p.fabric_type || p.part_name), Number(p.gsm) || null, null, kg, `parts (${p.part_name})`);
  }

  const lines: CadBomLine[] = [];
  const yarnKg = new Map<number, { kg: number; names: string[] }>();
  for (const g of groups.values()) {
    const fab = await matchFabric(db, cid, g.name, g.gsm);
    const label = `${g.name}${g.gsm ? ` ${g.gsm} GSM` : ''}${g.dia ? ` ${g.dia}"` : ''}`;
    if (!fab) { problems.push(`Fabric "${label}" is not in the fabric master — add it (or name it as in the master) and sync again`); continue; }
    const kg = r3(g.kg);
    // one line per colour when every colour of this fabric is a colour of the job (else one line for all colours)
    const cols = [...g.colours.entries()].map(([name, ckg]) => ({ name, kg: r3(ckg), jc: name ? jobColour(name) : null }));
    if (planCut > 0 && cols.length && cols.every((c) => c.jc)) {
      for (const c of cols) {
        const cpc = Number(c.jc!.pc);
        lines.push({ material_type: 'FABRIC', fabric_id: Number(fab.id), yarn_id: null, name: fab.fabric_name, dia: g.dia, gsm: g.gsm, uom: g.uom,
          color_id: Number(c.jc!.color_id), color_name: c.jc!.color_name, total_kg: c.kg, consumption: r5(c.kg / cpc),
          remarks: `CAD ${cr.req_no} ${cr.cad_version}: ${c.jc!.color_name} ${c.kg} ${g.uom} (${g.what}) ÷ ${cpc} plan-cut pcs of the colour` });
      }
    } else {
      lines.push({ material_type: 'FABRIC', fabric_id: Number(fab.id), yarn_id: null, name: fab.fabric_name, dia: g.dia, gsm: g.gsm, uom: g.uom,
        color_id: null, color_name: null, total_kg: kg, consumption: pcs > 0 ? r5(kg / pcs) : 0,
        remarks: `CAD ${cr.req_no} ${cr.cad_version}: ${kg} ${g.uom} (${g.what}) ÷ ${pcs} ${pcsSource}` });
    }
    if (g.uom === 'MTR') continue;   // woven fabric is bought, not knitted from yarn
    const yid = Number(fab.yarn_id) || yarnFallback;
    if (!yid) { problems.push(`Fabric "${fab.fabric_name}" has no yarn in the fabric master — set it to get the yarn requirement`); continue; }
    const y = yarnKg.get(yid) ?? { kg: 0, names: [] };
    y.kg += kg; y.names.push(fab.fabric_name); yarnKg.set(yid, y);
  }
  // flat-knit collar / cuff yarn
  const collar = dj.flat_knit_spec && dj.flat_knit_spec.enabled !== false ? Number(dj.flat_knit_spec.total_yarn_kg) || 0 : 0;
  const collarYarn = Number(dj.flat_knit_spec?.yarn_id) || yarnFallback;
  const yarnNames = yarnKg.size || collar ? await run<any>(db, `SELECT id, yarn_name FROM mst_yarn WHERE id IN (?)`, [[...yarnKg.keys(), collarYarn ?? 0]]) : [];
  for (const [yid, y] of yarnKg) {
    const kg = r3(y.kg * (1 + KNIT_LOSS_PCT / 100));
    lines.push({ material_type: 'YARN', fabric_id: null, yarn_id: yid, name: yarnNames.find((x) => Number(x.id) === yid)?.yarn_name ?? `Yarn #${yid}`, dia: null, gsm: null, uom: 'KG', color_id: null, color_name: null,
      total_kg: kg, consumption: pcs > 0 ? r5(kg / pcs) : 0,
      remarks: `CAD ${cr.req_no} ${cr.cad_version}: ${r3(y.kg)} KG fabric + ${KNIT_LOSS_PCT}% knitting loss = ${kg} KG ÷ ${pcs} ${pcsSource}` });
  }
  if (collar > 0) {
    if (!collarYarn) problems.push('Collar / cuff yarn: pick its yarn to get it into the BOM');
    else lines.push({ material_type: 'YARN', fabric_id: null, yarn_id: collarYarn, name: `${yarnNames.find((x) => Number(x.id) === collarYarn)?.yarn_name ?? 'Yarn'} (collar / cuff)`, dia: null, gsm: null, uom: 'KG', color_id: null, color_name: null,
      total_kg: r3(collar), consumption: pcs > 0 ? r5(collar / pcs) : 0, remarks: `CAD ${cr.req_no} ${cr.cad_version}: flat-knit collar / cuff yarn ${r3(collar)} KG ÷ ${pcs} ${pcsSource}` });
  }
  // a CAD without a fabric program must not empty the BOM's CAD lines
  if (!groups.size && !problems.length) problems.push(`${cr.req_no} ${cr.cad_version} has no fabric program — run the auto-consumption and save the CAD first`);
  return {
    cad_req_id: Number(cr.id), req_no: cr.req_no, cad_version: cr.cad_version, plan_cut_pcs: pcs, pcs_source: pcsSource,
    fabric_kg: r3(lines.filter((l) => l.material_type === 'FABRIC' && l.uom === 'KG').reduce((a, l) => a + l.total_kg, 0)),
    fabric_mtr: r3(lines.filter((l) => l.material_type === 'FABRIC' && l.uom === 'MTR').reduce((a, l) => a + l.total_kg, 0)),
    yarn_kg: r3(lines.filter((l) => l.material_type === 'YARN').reduce((a, l) => a + l.total_kg, 0)),
    lines, problems,
  };
}

export type SourcingMode = 'YARN_PURCHASE' | 'FABRIC_PURCHASE' | 'BOTH';

/**
 * Write the CAD lines into a BOM: the CAD-made FABRIC / YARN lines (remarks "CAD…") are replaced, lines added by
 * hand are kept. YARN_PURCHASE = fabric knitted in-house (PRODUCTION) from bought yarn; FABRIC_PURCHASE = fabric bought,
 * no yarn; BOTH = fabric bought + yarn lines.
 */
export async function applyCadToBom(tx: Tx, bomId: number, p: CadBomPreview, mode: SourcingMode) {
  const kg = (await txQuery<any>(tx, `SELECT id FROM cfg_uom WHERE code IN ('KG', 'KGS') ORDER BY code = 'KG' DESC LIMIT 1`, []))[0];
  const mtr = (await txQuery<any>(tx, `SELECT id FROM cfg_uom WHERE code IN ('MTR', 'MTRS', 'M') ORDER BY code = 'MTR' DESC LIMIT 1`, []))[0];
  const uomOf = (u: 'KG' | 'MTR') => (u === 'MTR' ? Number(mtr?.id) || Number(kg?.id) || 1 : Number(kg?.id) || 1);
  await txExecute(tx, `DELETE FROM trx_bom_line WHERE bom_id = ? AND material_type IN ('FABRIC', 'YARN') AND remarks LIKE 'CAD%'`, [bomId]);
  let n = 0;
  for (const l of p.lines) {
    if (l.material_type === 'YARN' && mode === 'FABRIC_PURCHASE') continue;
    const source = l.material_type === 'YARN' ? 'PURCHASE' : mode === 'YARN_PURCHASE' ? 'PRODUCTION' : 'PURCHASE';
    await txExecute(tx,
      `INSERT INTO trx_bom_line (bom_id, material_type, fabric_id, yarn_id, dia, gsm, color_id, consumption_basis, applicability, source_type, consumption, additional_qty, uom_id, wastage_pct, remarks)
       VALUES (?,?,?,?,?,?,?, 'PER_PIECE', ?, ?, ?, 0, ?, 0, ?)`,
      [bomId, l.material_type, l.fabric_id, l.yarn_id, l.dia, l.gsm, l.color_id, l.color_id ? 'COLOUR_WISE' : 'ALL', source, l.consumption, uomOf(l.uom), l.remarks.slice(0, 255)]);
    n++;
  }
  return n;
}

/** Yarn of the BOM's current CAD yarn line (kept when a fabric's master has no yarn). */
export async function bomCadYarn(db: Db, bomId: number): Promise<number | null> {
  const r = (await run<any>(db, `SELECT yarn_id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'YARN' AND yarn_id IS NOT NULL ORDER BY (remarks LIKE 'CAD%') DESC, id LIMIT 1`, [bomId]))[0];
  return r ? Number(r.yarn_id) : null;
}

/** The CAD a style's BOM takes: its latest approved CAD (else its latest CAD). */
export async function latestCadOfStyle(cid: number, styleId: number) {
  return queryOne<any>(
    `SELECT cr.id, cr.req_no, cr.cad_version, cr.status FROM trx_cad_requirement cr
      WHERE cr.company_id = ? AND cr.style_id = ? ORDER BY (cr.status = 'APPROVED') DESC, cr.id DESC LIMIT 1`, [cid, styleId]);
}
