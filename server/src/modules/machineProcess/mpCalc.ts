/**
 * Embroidery / printing costing service — pure calculations (developer docs §11–§17 / §25 embroidery,
 * §10–§15 / §23 printing). The routes load the data, this file does the arithmetic, so the screen only
 * ever shows server-calculated totals and the approved snapshot can be reproduced from its inputs.
 *
 *   Net run hours   = end − start − break − downtime − setup
 *   Costing hours   = net run hours (+ setup when MP_SETUP_IN_COSTING = 1)
 *   Machine cost    = costing hours × machine hour rate             (MACHINE_HOUR method)
 *                   = costing hours × (depreciation + power + maint.) (COMPONENT method)
 *                     × heads used when the rates are per head-hour
 *   Labour cost     = labour hours (end − start − break) × (operators × operator rate + helpers × helper rate)
 *   Overhead        = costing hours × overhead rate  |  % of material + machine + labour
 *   Total           = material + machine + labour + overhead + other
 *   Cost / good pc  = total ÷ good output;  cost / kg = total ÷ good kg;  cost / 1,000 stitches = total ÷ stitches × 1,000
 */

export type Kind = 'EMBROIDERY' | 'PRINTING';

export const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000;
export const r6 = (v: number) => Math.round((v + Number.EPSILON) * 1e6) / 1e6;
const n = (v: unknown) => Number(v ?? 0) || 0;
const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);

/** Material roles that count as "thread" (embroidery) / "dyes" (printing); the rest is consumable / chemical. */
export const PRIMARY_ROLES: Record<Kind, string[]> = {
  EMBROIDERY: ['THREAD', 'BOBBIN'],
  PRINTING: ['DYE', 'PIGMENT', 'INK'],
};

export interface RateRow {
  id?: number;
  costing_method: 'MACHINE_HOUR' | 'COMPONENT';
  rate_basis: 'MACHINE' | 'HEAD';
  machine_hour_rate: number; depreciation_rate_hour: number; electricity_rate_hour: number; maintenance_rate_hour: number;
  overhead_basis: 'HOUR' | 'PERCENT'; overhead_rate_hour: number; overhead_pct: number;
  operator_rate_hour: number; helper_rate_hour: number;
}

export interface MachineRow {
  head_count: number; capacity_stitches_hour: number | null; capacity_per_hour: number | null;
}

// ------------------------------------------------------------------ time
export function calculateRunningHours(p: {
  start_at: string | Date; end_at: string | Date; break_minutes: number; setup_minutes: number; downtime_minutes: number; setupInCosting: boolean;
}) {
  const start = new Date(p.start_at).getTime();
  const end = new Date(p.end_at).getTime();
  const gross = (end - start) / 60000;
  const attended = gross - n(p.break_minutes);
  const net = attended - n(p.downtime_minutes) - n(p.setup_minutes);
  const costing = net + (p.setupInCosting ? n(p.setup_minutes) : 0);
  return {
    gross_minutes: r4(gross),
    attended_hours: r4(Math.max(attended, 0) / 60),
    net_run_minutes: r4(net),
    net_run_hours: r4(Math.max(net, 0) / 60),
    costing_hours: r4(Math.max(costing, 0) / 60),
    utilization_pct: attended > 0 ? r2((Math.max(net, 0) / attended) * 100) : null,
  };
}

// ------------------------------------------------------------------ output balance
/** input = good + reject + rework (+ an adjustment that needs a reason); nothing may be negative. */
export function validateOutputBalance(p: { input_qty: number; good_qty: number; reject_qty: number; rework_qty: number }) {
  const errors: string[] = [];
  for (const k of ['input_qty', 'good_qty', 'reject_qty', 'rework_qty'] as const) {
    if (n(p[k]) < 0) errors.push(`${k.replace('_qty', '')} cannot be negative`);
  }
  const adjustment = r4(n(p.input_qty) - n(p.good_qty) - n(p.reject_qty) - n(p.rework_qty));
  return { adjustment_qty: adjustment, balanced: Math.abs(adjustment) < 0.00005, errors };
}

// ------------------------------------------------------------------ standard consumption
export interface RecipeLine {
  id?: number; trim_id: number; material_role: string; basis: 'PER_PIECE' | 'PER_BASE' | 'PER_1000_STITCH';
  std_qty: number; loss_pct: number; per_stock_unit: number; uom_id: number;
}
/**
 * Standard qty of one recipe line for a production qty, in the line's consumption UOM.
 *   PER_PIECE        qty × std
 *   PER_BASE         qty ÷ recipe base qty × std               (printing: grams per 100 PCS / per KG …)
 *   PER_1000_STITCH  qty × stitches per piece ÷ 1,000 × std   (embroidery thread factor, doc §17)
 * then × (1 + loss % / 100).
 */
export function standardQty(line: RecipeLine, qty: number, baseQty: number, stitchesPerPc: number | null) {
  let raw = 0;
  if (line.basis === 'PER_PIECE') raw = qty * n(line.std_qty);
  else if (line.basis === 'PER_BASE') raw = n(baseQty) > 0 ? (qty / n(baseQty)) * n(line.std_qty) : 0;
  else raw = (qty * n(stitchesPerPc)) / 1000 * n(line.std_qty);
  return r6(raw * (1 + n(line.loss_pct) / 100));
}
export function calculateStandardConsumption(lines: RecipeLine[], qty: number, baseQty: number, stitchesPerPc: number | null) {
  return lines.map((l) => ({ ...l, standard_qty: standardQty(l, qty, baseQty, stitchesPerPc) }));
}

/** Actual = what the entry says, else issued − returned against the entry, else the standard. */
export function calculateActualConsumption(c: { actual_qty?: number | null; issued_qty: number; returned_qty: number; standard_qty: number }) {
  if (c.actual_qty != null) return r6(n(c.actual_qty));
  const net = n(c.issued_qty) - n(c.returned_qty);
  return r6(net > 0 ? net : n(c.standard_qty));
}

export function calculateVariance(actual: number, standard: number) {
  const v = r6(n(actual) - n(standard));
  return { variance: v, variance_pct: n(standard) > 0 ? r2((v / n(standard)) * 100) : null };
}

// ------------------------------------------------------------------ cost
const headFactor = (rate: RateRow, headsUsed: number) => (rate.rate_basis === 'HEAD' ? Math.max(n(headsUsed), 1) : 1);
export const machineHourly = (rate: RateRow) => (rate.costing_method === 'MACHINE_HOUR'
  ? n(rate.machine_hour_rate)
  : n(rate.depreciation_rate_hour) + n(rate.electricity_rate_hour) + n(rate.maintenance_rate_hour));

export function calculateMachineCost(rate: RateRow, costingHours: number, headsUsed: number) {
  return r4(n(costingHours) * machineHourly(rate) * headFactor(rate, headsUsed));
}
export function calculateLabourCost(rate: RateRow, labourHours: number, operators: number, helpers: number) {
  const operator = r4(n(labourHours) * n(operators) * n(rate.operator_rate_hour));
  const helper = r4(n(labourHours) * n(helpers) * n(rate.helper_rate_hour));
  return { operator, helper, total: r4(operator + helper) };
}
export function calculateOverhead(rate: RateRow, costingHours: number, base: number) {
  return rate.overhead_basis === 'PERCENT' ? r4(n(base) * n(rate.overhead_pct) / 100) : r4(n(costingHours) * n(rate.overhead_rate_hour));
}
export function calculateTotalCost(c: { material: number; machine: number; labour: number; overhead: number; other: number }) {
  return r4(n(c.material) + n(c.machine) + n(c.labour) + n(c.overhead) + n(c.other));
}
export const calculateCostPerUnit = (total: number, qty: number | null | undefined) => (n(qty) > 0 ? r4(n(total) / n(qty)) : null);
export const calculateCostPer1000Stitches = (total: number, stitches: number | null | undefined) =>
  (n(stitches) > 0 ? r4((n(total) / n(stitches)) * 1000) : null);

/**
 * Standard machine hours for a qty: design standard minutes / piece (per head cycle), else stitch capacity,
 * else output capacity — scaled to the heads used on a multi-head machine.
 */
export function standardHours(kind: Kind, m: MachineRow, p: { qty: number; stitches: number | null; heads_used: number; std_minutes_per_pc?: number | null }) {
  const heads = Math.max(n(p.heads_used), 1);
  const share = kind === 'EMBROIDERY' && n(m.head_count) > 0 ? Math.min(heads / n(m.head_count), 1) : 1;
  if (kind === 'EMBROIDERY' && n(p.std_minutes_per_pc) > 0) return r4((n(p.qty) * n(p.std_minutes_per_pc)) / 60 / heads);
  if (kind === 'EMBROIDERY' && n(m.capacity_stitches_hour) > 0 && n(p.stitches) > 0) return r4(n(p.stitches) / (n(m.capacity_stitches_hour) * share));
  if (n(m.capacity_per_hour) > 0) return r4(n(p.qty) / (n(m.capacity_per_hour) * share));
  return 0;
}

export interface ConsumptionCalc {
  trim_id: number; material_role: string | null; standard_qty: number; actual_qty: number; unit_cost: number;
}

/** Full production costing (actual and standard) — the snapshot written to trx_mp_costing. */
export function calculateProductionCost(kind: Kind, p: {
  machine: MachineRow; rate: RateRow; setupInCosting: boolean;
  start_at: string | Date; end_at: string | Date; break_minutes: number; setup_minutes: number; downtime_minutes: number;
  heads_used: number; operator_count: number; helper_count: number;
  input_qty: number; good_qty: number; reject_qty: number; rework_qty: number; good_weight_kg: number | null; output_uom: string;
  total_stitches: number | null; stitches_per_pc: number | null; std_minutes_per_pc: number | null;
  other_cost: number; consumption: ConsumptionCalc[];
}) {
  const t = calculateRunningHours(p);
  const primary = PRIMARY_ROLES[kind];
  let thread = 0; let consumable = 0; let stdMaterial = 0;
  for (const c of p.consumption) {
    const cost = n(c.actual_qty) * n(c.unit_cost);
    if (c.material_role && primary.includes(c.material_role)) thread += cost; else consumable += cost;
    stdMaterial += n(c.standard_qty) * n(c.unit_cost);
  }
  thread = r4(thread); consumable = r4(consumable);
  const material = r4(thread + consumable);
  const machine = calculateMachineCost(p.rate, t.costing_hours, p.heads_used);
  const labour = calculateLabourCost(p.rate, t.attended_hours, p.operator_count, p.helper_count).total;
  const overhead = calculateOverhead(p.rate, t.costing_hours, material + machine + labour);
  const other = r4(n(p.other_cost));
  const total = calculateTotalCost({ material, machine, labour, overhead, other });

  // Standard: what processing the input qty should cost at standard time and standard consumption.
  const processed = n(p.input_qty);
  const stdStitches = n(p.stitches_per_pc) > 0 ? processed * n(p.stitches_per_pc) : null;
  const stdHours = standardHours(kind, p.machine, { qty: processed, stitches: stdStitches, heads_used: p.heads_used, std_minutes_per_pc: p.std_minutes_per_pc });
  const stdHoursGood = standardHours(kind, p.machine, {
    qty: n(p.good_qty), stitches: n(p.stitches_per_pc) > 0 ? n(p.good_qty) * n(p.stitches_per_pc) : null,
    heads_used: p.heads_used, std_minutes_per_pc: p.std_minutes_per_pc,
  });
  const stdMachine = calculateMachineCost(p.rate, stdHours, p.heads_used);
  const stdLabour = calculateLabourCost(p.rate, stdHours, p.operator_count, p.helper_count).total;
  const stdOverhead = calculateOverhead(p.rate, stdHours, stdMaterial + stdMachine + stdLabour);
  const stdTotal = r4(stdMaterial + stdMachine + stdLabour + stdOverhead);

  const stitches = n(p.total_stitches) > 0 ? n(p.total_stitches) : null;
  const goodKg = p.output_uom === 'KG' ? n(p.good_qty) : n(p.good_weight_kg) > 0 ? n(p.good_weight_kg) : null;
  return {
    gross_minutes: t.gross_minutes, net_run_hours: t.net_run_hours, costing_hours: t.costing_hours, labour_hours: t.attended_hours,
    standard_hours: stdHours,
    thread_cost: thread, consumable_cost: consumable, material_cost: material, machine_cost: machine, labour_cost: labour,
    overhead_cost: overhead, other_cost: other, total_cost: total,
    std_material_cost: r4(stdMaterial), std_machine_cost: stdMachine, std_labour_cost: stdLabour, std_overhead_cost: stdOverhead, std_total_cost: stdTotal,
    good_qty: n(p.good_qty), good_weight_kg: goodKg, total_stitches: stitches,
    cost_per_unit: calculateCostPerUnit(total, p.good_qty),
    cost_per_kg: goodKg ? r4(total / goodKg) : null,
    cost_per_1000_stitches: calculateCostPer1000Stitches(total, stitches),
    output_per_hour: t.net_run_hours > 0 ? r4(n(p.good_qty) / t.net_run_hours) : null,
    stitches_per_hour: stitches && t.net_run_hours > 0 ? r4(stitches / t.net_run_hours) : null,
    efficiency_pct: t.net_run_hours > 0 && stdHoursGood > 0 ? r2((stdHoursGood / t.net_run_hours) * 100) : null,
    utilization_pct: t.utilization_pct,
    reject_pct: pct(n(p.reject_qty), n(p.input_qty)),
    rework_pct: pct(n(p.rework_qty), n(p.input_qty)),
  };
}
export type ProductionCost = ReturnType<typeof calculateProductionCost>;
