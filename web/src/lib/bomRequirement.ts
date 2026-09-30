/**
 * BOM requirement on the client — mirrors server/src/core/bomRequirement.ts so the BOM
 * screen shows exactly what MRP, the BOM print and the PO / quotation BOM pick use:
 *   qty a line applies to = plan-cut PCS of the order cells it covers (all, one colour,
 *   one size, or one colour-size); requirement = qty × consumption (÷ 12 per dozen,
 *   or the fixed qty) + wastage % + additional qty; countable units round up.
 */
export interface OrderCell { color_id: number | null; size_id: number | null; qty: number; plan_cut: number }

const n = (v: unknown) => Number(v ?? 0) || 0;

export const cellsPlanCut = (cells: OrderCell[]) => cells.reduce((a, c) => a + c.plan_cut, 0);

export function cellsFor(line: { color_id?: unknown; size_id?: unknown }, cells: OrderCell[]) {
  const color = line.color_id ? Number(line.color_id) : null;
  const size = line.size_id ? Number(line.size_id) : null;
  if (!color && !size) return cells;
  return cells.filter((c) => (!color || c.color_id === color) && (!size || c.size_id === size));
}

export function lineRequirement(line: { consumption?: unknown; consumption_basis?: unknown; wastage_pct?: unknown; additional_qty?: unknown }, qty: number) {
  const cons = n(line.consumption);
  const basis = String(line.consumption_basis || 'PER_PIECE');
  const base = basis === 'PER_DOZEN' ? (qty / 12) * cons : basis === 'FIXED_QTY' ? cons : qty * cons;
  const waste = base * (n(line.wastage_pct) / 100);
  const addl = n(line.additional_qty);
  return { basis, base, waste, addl, required: base + waste + addl };
}

/** Countable units are bought in whole numbers (same list as /boms/for-job). */
export const isCountableUom = (code?: string | null) => ['PCS', 'NOS', 'PC', 'SET'].includes(String(code || '').toUpperCase());
