/**
 * Merchandiser Pre-Costing V2 — the one per-piece roll-up of a pre-costing
 * sheet's rows (trx_costing.data_json) into the trx_costing head columns,
 * total_cost and fob_price.
 *
 * The server runs this on every create / update of a PRE_COSTING costing
 * (resources/transactions.ts `costings.beforeWrite`) — client totals are never
 * stored. web/src/lib/preCostingCalc.ts is a line-for-line mirror used only
 * for the live figures on screen; keep the two identical.
 *
 * Tab → head mapping (all ₹ per piece, 4 dp):
 *   fabrics             fabric_cost   Σ cons × (1 + wastage%) × rate  (0 when useYarnRecipe)
 *   yarns               yarn_cost     Σ cons × (1 + wastage%) × rate  (only when useYarnRecipe)
 *   trims               trim_cost     Σ cons × (1 + wastage%) × rate
 *   embellishments      printing_cost / embroidery_cost (type containing "EMB" → embroidery)
 *   processes           basis PER_KG: consumption(kg/pc) × rate, PER_PC: rate
 *                         KNITTING                          → knitting_cost
 *                         DYEING, COMPACTING (fabric proc.) → dyeing_cost
 *                         WASHING, OTHER / unknown          → washing_cost
 *                       (rows saved before the type existed: type inferred from the name)
 *   cuttingOps          cutting_cost  Σ rate
 *   sewing              stitching_cost = flat rate, or Σ SMV × smv_rate_per_min; smv = Σ SMV
 *   finishingItems      qty/pc × rate → finishing_cost (FINISHING) / packing_cost (PACKING)
 *                       (older sheets: `packings` rows = PACKING, qty = consumption)
 *   otherDirect         TESTING → testing_cost, FREIGHT → freight_cost,
 *                       AGENT_COMMISSION → agent_commission, FINANCE → finance_cost,
 *                       OTHER → other_direct_cost. Basis PER_PC (₹), PCT_DIRECT
 *                       (% of manufacturing direct cost) or PCT_FOB (% of FOB).
 *                       (older sheets: `otherCharges` {charge_type, rate_per_pc} = PER_PC)
 *   overhead            PER_PIECE: rate, PERCENT_DIRECT: pct × direct cost before FOB-% charges
 *
 * Formula:
 *   M   = manufacturing direct (materials, processes, embellishment, cutting, sewing, finishing, packing)
 *   X   = M + PER_PC charges + PCT_DIRECT charges (PCT_DIRECT on M)
 *   OH  = overhead (PERCENT_DIRECT on X)
 *   q   = Σ PCT_FOB % / 100,  m = margin % / 100
 *   FOB = (X + OH) / (1 − m − q)          (so that FOB = total / (1 − m) holds)
 *   total_cost = X + OH + q × FOB         (= Σ of the stored heads)
 *
 * A tab key missing from data_json (sheets saved before the tab existed) keeps
 * that head's current value (`fallback`); a key present with no rows is 0.
 */

export type PreCostHeadKey =
  | 'fabric_cost' | 'yarn_cost' | 'trim_cost' | 'knitting_cost' | 'dyeing_cost'
  | 'printing_cost' | 'embroidery_cost' | 'washing_cost' | 'cutting_cost'
  | 'stitching_cost' | 'finishing_cost' | 'packing_cost' | 'testing_cost'
  | 'freight_cost' | 'agent_commission' | 'finance_cost' | 'other_direct_cost'
  | 'overhead_cost';

export const PRE_COST_HEADS: PreCostHeadKey[] = [
  'fabric_cost', 'yarn_cost', 'trim_cost', 'knitting_cost', 'dyeing_cost',
  'printing_cost', 'embroidery_cost', 'washing_cost', 'cutting_cost',
  'stitching_cost', 'finishing_cost', 'packing_cost', 'testing_cost',
  'freight_cost', 'agent_commission', 'finance_cost', 'other_direct_cost',
  'overhead_cost',
];

/** Direct heads (every head except overhead). */
const DIRECT_HEADS = PRE_COST_HEADS.filter((h) => h !== 'overhead_cost');
const OTHER_DIRECT_HEADS: PreCostHeadKey[] = ['testing_cost', 'freight_cost', 'agent_commission', 'finance_cost', 'other_direct_cost'];

/** Top-level data_json keys written by the V2 sheet (the Classic sheet nests under `classic`). */
export const PRE_COST_V2_KEYS = [
  'fabrics', 'yarns', 'trims', 'embellishments', 'processes', 'sewingOps', 'useFlatSewingRate',
  'cuttingOps', 'finishingItems', 'packings', 'otherDirect', 'otherCharges', 'overhead',
];

export const PROCESS_TYPES = ['KNITTING', 'DYEING', 'COMPACTING', 'WASHING', 'OTHER'] as const;
export const OTHER_DIRECT_TYPES = ['TESTING', 'FREIGHT', 'AGENT_COMMISSION', 'FINANCE', 'OTHER'] as const;

export interface PreCostInput {
  margin_pct?: unknown;
  smv_rate_per_min?: unknown;
  /** Current head values, kept for a tab whose key is missing from data_json. */
  fallback?: Partial<Record<PreCostHeadKey | 'smv', unknown>>;
}

export interface PreCostResult {
  heads: Record<PreCostHeadKey, number>;
  smv: number;
  manufacturing_direct: number;
  direct_cost: number;
  overhead_cost: number;
  fob_pct_charges: number;
  total_cost: number;
  margin_pct: number;
  fob_price: number;
  profit_per_pc: number;
  markup_pct: number;
  /** Set when margin % + % of FOB charges reach 100 (no finite FOB). */
  error: string | null;
}

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const has = (dj: any, k: string) => dj != null && Object.prototype.hasOwnProperty.call(dj, k) && dj[k] != null;

/** Process row → head. Explicit type wins; older rows are classified by their name. */
export function processHead(row: any): PreCostHeadKey {
  const t = String(row?.process_type ?? '').toUpperCase();
  const name = String(row?.process_name ?? '').toUpperCase();
  const key = PROCESS_TYPES.includes(t as any) ? t
    : /KNIT/.test(name) ? 'KNITTING'
    : /DYE|DYING|COMPACT|BLEACH|MERCER|RAIS|BRUSH|PEACH|SANFOR/.test(name) ? 'DYEING'
    : 'WASHING';
  if (key === 'KNITTING') return 'knitting_cost';
  if (key === 'DYEING' || key === 'COMPACTING') return 'dyeing_cost';
  return 'washing_cost';
}

/** Process row amount per piece. Older rows ("Per Garment" / no basis) are per piece. */
export function processAmount(row: any): number {
  const basis = String(row?.basis ?? '').toUpperCase().replace(/[\s-]/g, '_');
  if (basis === 'PER_KG' || basis === 'KG') return n(row?.consumption) * n(row?.rate);
  return n(row?.rate);
}

export function otherDirectType(row: any): (typeof OTHER_DIRECT_TYPES)[number] {
  const t = String(row?.charge_type ?? '').toUpperCase();
  if (OTHER_DIRECT_TYPES.includes(t as any)) return t as any;
  if (/TEST|LAB|INSPECT/.test(t)) return 'TESTING';
  if (/FREIGHT|COURIER|TRANSPORT|SHIPPING/.test(t)) return 'FREIGHT';
  if (/COMMISSION|AGENT/.test(t)) return 'AGENT_COMMISSION';
  if (/FINANCE|INTEREST|BANK/.test(t)) return 'FINANCE';
  return 'OTHER';
}

const OTHER_HEAD: Record<(typeof OTHER_DIRECT_TYPES)[number], PreCostHeadKey> = {
  TESTING: 'testing_cost', FREIGHT: 'freight_cost', AGENT_COMMISSION: 'agent_commission',
  FINANCE: 'finance_cost', OTHER: 'other_direct_cost',
};

/** Other Direct rows in the current shape (older `otherCharges` rows converted). */
export function otherDirectRows(dj: any): any[] {
  if (has(dj, 'otherDirect')) return arr(dj.otherDirect);
  return arr(dj?.otherCharges).map((r) => ({
    charge_type: otherDirectType(r), description: r?.charge_type ?? '', basis: 'PER_PC', value: n(r?.rate_per_pc),
  }));
}

/** Finishing & Packing rows in the current shape (older `packings` rows are PACKING). */
export function finishingRows(dj: any): any[] {
  if (has(dj, 'finishingItems')) return arr(dj.finishingItems);
  return arr(dj?.packings).map((r) => ({
    item: r?.item ?? '', cost_type: 'PACKING', qty_per_pc: n(r?.consumption), rate: n(r?.rate),
  }));
}

const gross = (r: any) => n(r?.consumption) * (1 + n(r?.wastage_pct) / 100) * n(r?.rate);

export function computePreCosting(dataJson: any, input: PreCostInput = {}): PreCostResult {
  const dj = dataJson && typeof dataJson === 'object' ? dataJson : {};
  const fb = input.fallback ?? {};
  const heads = {} as Record<PreCostHeadKey, number>;
  for (const h of PRE_COST_HEADS) heads[h] = n(fb[h]);
  const useYarn = dj.useYarnRecipe === true;

  // Materials
  if (has(dj, 'fabrics')) heads.fabric_cost = useYarn ? 0 : arr(dj.fabrics).reduce((s, r) => s + gross(r), 0);
  if (has(dj, 'yarns')) heads.yarn_cost = useYarn ? arr(dj.yarns).reduce((s, r) => s + gross(r), 0) : 0;
  if (has(dj, 'trims')) heads.trim_cost = arr(dj.trims).reduce((s, r) => s + gross(r), 0);

  // Printing & embroidery
  if (has(dj, 'embellishments')) {
    heads.printing_cost = 0; heads.embroidery_cost = 0;
    for (const e of arr(dj.embellishments)) {
      if (String(e?.type ?? '').toUpperCase().includes('EMB')) heads.embroidery_cost += n(e?.rate);
      else heads.printing_cost += n(e?.rate);
    }
  }

  // Processes
  if (has(dj, 'processes')) {
    heads.knitting_cost = 0; heads.dyeing_cost = 0; heads.washing_cost = 0;
    for (const p of arr(dj.processes)) heads[processHead(p)] += processAmount(p);
  }

  // Cutting
  if (has(dj, 'cuttingOps')) heads.cutting_cost = arr(dj.cuttingOps).reduce((s, r) => s + n(r?.rate), 0);

  // Sewing
  const ops = arr(dj.sewingOps);
  const smvSum = ops.reduce((s, r) => s + n(r?.smv), 0);
  const smv = has(dj, 'sewingOps') && smvSum > 0 ? smvSum : n(fb.smv);
  if (dj.useFlatSewingRate === true) heads.stitching_cost = n(dj.flatSewingRate);
  else if (has(dj, 'sewingOps') || dj.useFlatSewingRate === false) heads.stitching_cost = smv * n(input.smv_rate_per_min);

  // Finishing & packing
  if (has(dj, 'finishingItems') || has(dj, 'packings')) {
    const rows = finishingRows(dj);
    const amt = (r: any) => n(r?.qty_per_pc) * n(r?.rate);
    const fin = rows.filter((r) => String(r?.cost_type ?? '').toUpperCase() === 'FINISHING').reduce((s, r) => s + amt(r), 0);
    const pack = rows.filter((r) => String(r?.cost_type ?? '').toUpperCase() !== 'FINISHING').reduce((s, r) => s + amt(r), 0);
    heads.packing_cost = pack;
    // Older sheets had only packing rows and a flat finishing figure — that figure is kept.
    if (has(dj, 'finishingItems')) heads.finishing_cost = fin;
  }

  for (const h of PRE_COST_HEADS) heads[h] = r4(heads[h]);
  const M = r4(DIRECT_HEADS.filter((h) => !OTHER_DIRECT_HEADS.includes(h)).reduce((s, h) => s + heads[h], 0));

  // Other direct charges
  const otherTab = has(dj, 'otherDirect') || has(dj, 'otherCharges');
  const fobPct: Record<string, number> = {};
  let q = 0;
  if (otherTab) {
    for (const h of OTHER_DIRECT_HEADS) heads[h] = 0;
    for (const r of otherDirectRows(dj)) {
      const head = OTHER_HEAD[otherDirectType(r)];
      const basis = String(r?.basis ?? 'PER_PC').toUpperCase();
      const v = n(r?.value);
      if (basis === 'PCT_FOB') { fobPct[head] = (fobPct[head] ?? 0) + v / 100; q += v / 100; }
      else if (basis === 'PCT_DIRECT') heads[head] += (M * v) / 100;
      else heads[head] += v;
    }
  }
  const X = M + OTHER_DIRECT_HEADS.reduce((s, h) => s + heads[h], 0);

  // Overhead
  if (has(dj, 'overhead')) {
    const o = dj.overhead ?? {};
    heads.overhead_cost = String(o.basis ?? '').toUpperCase() === 'PERCENT_DIRECT' ? (X * n(o.pct)) / 100 : n(o.rate);
  }
  heads.overhead_cost = r4(heads.overhead_cost);
  const base = X + heads.overhead_cost;

  const m = n(input.margin_pct) / 100;
  let error: string | null = null;
  let F: number;
  if (1 - m - q <= 0.0001) {
    error = `Margin ${r4(m * 100)}% + % of FOB charges ${r4(q * 100)}% must be below 100%`;
    F = base;
    q = 0;
  } else {
    F = base / (1 - m - q);
  }
  let fobPctAmount = 0;
  for (const [h, pct] of Object.entries(fobPct)) {
    if (error) continue;
    heads[h as PreCostHeadKey] += F * pct;
    fobPctAmount += F * pct;
  }
  for (const h of OTHER_DIRECT_HEADS) heads[h] = r4(heads[h]);

  const total = r4(PRE_COST_HEADS.reduce((s, h) => s + heads[h], 0));
  const fob = error ? total : r4(m > 0 ? total / (1 - m) : total);
  const direct = r4(total - heads.overhead_cost);
  return {
    heads,
    smv: Math.round(smv * 100) / 100,
    manufacturing_direct: M,
    direct_cost: direct,
    overhead_cost: heads.overhead_cost,
    fob_pct_charges: r4(fobPctAmount),
    total_cost: total,
    margin_pct: r4(m * 100),
    fob_price: fob,
    profit_per_pc: r4(fob - total),
    markup_pct: total > 0 ? r4(((fob - total) / total) * 100) : 0,
    error,
  };
}
