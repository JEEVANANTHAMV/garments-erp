import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber } from '../../lib/format';
import { cellsFor, cellsPlanCut, lineRequirement, isCountableUom, type OrderCell } from '../../lib/bomRequirement';

/** Row tint / badge per material type — the same colours as the BOM tabs. */
export const TYPE_TONE: Record<string, { row: string; badge: string; bar: string }> = {
  FABRIC:    { row: 'bg-emerald-50/60', badge: 'bg-emerald-100 text-emerald-800 border-emerald-300', bar: 'border-l-emerald-500' },
  YARN:      { row: 'bg-amber-50/70',   badge: 'bg-amber-100 text-amber-800 border-amber-300',       bar: 'border-l-amber-500' },
  TRIM:      { row: 'bg-indigo-50/60',  badge: 'bg-indigo-100 text-indigo-800 border-indigo-300',    bar: 'border-l-indigo-500' },
  ACCESSORY: { row: 'bg-purple-50/60',  badge: 'bg-purple-100 text-purple-800 border-purple-300',    bar: 'border-l-purple-500' },
  PACKING:   { row: 'bg-sky-50/60',     badge: 'bg-sky-100 text-sky-800 border-sky-300',             bar: 'border-l-sky-500' },
  GENERAL:   { row: 'bg-teal-50/60',    badge: 'bg-teal-100 text-teal-800 border-teal-300',          bar: 'border-l-teal-500' },
};

export interface OrderInfo {
  so_id: number; job_no: string; so_no: string; buyer_name: string | null; buyer_po_no: string | null;
  style_code: string | null; style_name: string | null;
  sizes: { size_id: number; code: string; qty: number; plan_cut: number }[];
  colors: { color_id: number; name: string; qty: number; plan_cut: number }[];
  totals: { qty: number; plan_cut: number };
  cells: OrderCell[];
}

export function useOrderInfo(soId: number | null, styleId: number | null) {
  return useQuery({
    queryKey: ['boms', 'order-cells', soId, styleId],
    queryFn: async () => (await http.get<{ data: OrderInfo }>(`/boms/order-cells?so_id=${soId}&style_id=${styleId}`)).data,
    enabled: !!soId && !!styleId,
    staleTime: 60 * 1000,
  });
}

/** Job strip above the BOM lines: job, buyer, style and the size-wise order / plan-cut quantity. */
export function BomOrderStrip({ info }: { info: OrderInfo }) {
  const excess = info.totals.plan_cut - info.totals.qty;
  return (
    <div className="card mb-4 overflow-x-auto p-3">
      <div className="flex flex-wrap items-stretch gap-x-6 gap-y-2 text-xs">
        {[['Job / IO No', info.job_no], ['Buyer', info.buyer_name], ['Buyer PO', info.buyer_po_no], ['Style', [info.style_code, info.style_name].filter(Boolean).join(' — ')]].map(([k, v]) => (
          <div key={k as string}>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div>
            <div className="font-semibold text-slate-900">{v || '—'}</div>
          </div>
        ))}
        <table className="ml-auto text-right tabular-nums">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-wider text-slate-500">
              <th className="px-2 text-left font-semibold">Size</th>
              {info.sizes.map((s) => <th key={s.size_id} className="px-2 font-semibold">{s.code}</th>)}
              <th className="px-2 font-semibold text-slate-700">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-2 text-left text-slate-500">Order qty</td>
              {info.sizes.map((s) => <td key={s.size_id} className="px-2">{fmtNumber(s.qty)}</td>)}
              <td className="px-2 font-semibold">{fmtNumber(info.totals.qty)}</td>
            </tr>
            <tr className="font-semibold text-brand-700">
              <td className="px-2 text-left">Plan cut{excess > 0 ? ' (incl. excess)' : ''}</td>
              {info.sizes.map((s) => <td key={s.size_id} className="px-2">{fmtNumber(s.plan_cut)}</td>)}
              <td className="px-2">{fmtNumber(info.totals.plan_cut)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ReqLine {
  material_type: string; yarn_id: unknown; fabric_id: unknown; trim_id: unknown; item_description: string; specification: string;
  color_id: unknown; size_id: unknown; consumption_basis: string; consumption: unknown; additional_qty: unknown; uom_id: unknown; wastage_pct: unknown;
}

/**
 * Total requirement, one row per material (a material entered size-wise or colour-wise over
 * several BOM lines is shown on a single row): consumption per size, plan-cut qty per size,
 * base qty, wastage qty and the total to buy — computed exactly like MRP / the PO BOM pick.
 */
export function BomRequirementTable({ lines, info, materialName, uomCode }: {
  lines: ReqLine[]; info: OrderInfo; materialName: (l: ReqLine) => string; uomCode: (id: unknown) => string;
}) {
  const colorName = (id: unknown) => info.colors.find((c) => c.color_id === Number(id))?.name ?? `#${id}`;
  const rows = useMemo(() => {
    const groups = new Map<string, ReqLine[]>();
    for (const l of lines) {
      if (!(Number(l.consumption) > 0) && !(Number(l.additional_qty) > 0)) continue;
      const mat = l.yarn_id || l.fabric_id || l.trim_id || l.item_description;
      if (!mat) continue;
      const k = [l.material_type, mat, l.color_id || '', (l.specification || '').trim(), l.consumption_basis, l.uom_id].join('|');
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    return [...groups.values()].map((ls) => {
      const l0 = ls[0];
      const fixed = ls.every((l) => l.consumption_basis === 'FIXED_QTY');
      const perSize = info.sizes.map((s) => {
        const applies = ls.filter((l) => l.consumption_basis !== 'FIXED_QTY' && (!l.size_id || Number(l.size_id) === s.size_id));
        const cons = applies.reduce((a, l) => a + (Number(l.consumption) || 0), 0);
        const qty = applies.length
          ? cellsPlanCut(info.cells.filter((c) => c.size_id === s.size_id && (!l0.color_id || c.color_id === Number(l0.color_id))))
          : 0;
        return { cons: applies.length ? cons : null, qty };
      });
      const covered = new Set<OrderCell>();
      let base = 0, waste = 0, addl = 0, total = 0;
      const countable = isCountableUom(uomCode(l0.uom_id));
      for (const l of ls) {
        const cs = cellsFor(l, info.cells);
        cs.forEach((c) => covered.add(c));
        const r = lineRequirement(l, cellsPlanCut(cs));
        base += r.base; waste += r.waste; addl += r.addl;
        total += countable ? Math.ceil(Number(r.required.toFixed(4))) : r.required;
      }
      const orderQty = cellsPlanCut([...covered]);
      const wPcts = [...new Set(ls.map((l) => Number(l.wastage_pct) || 0))];
      const consQty = perSize.reduce((a, p) => a + (p.cons ?? 0) * p.qty, 0);
      const qtySum = perSize.reduce((a, p) => a + (p.cons != null ? p.qty : 0), 0);
      return {
        l0, name: materialName(l0), fixed, perSize, orderQty, base, waste, addl, total,
        avg: fixed ? Number(l0.consumption) || 0 : qtySum > 0 ? consQty / qtySum : Number(l0.consumption) || 0,
        wastePct: wPcts.length === 1 ? wPcts[0] : base > 0 ? (waste / base) * 100 : 0,
        mixedWaste: wPcts.length > 1,
        lineCount: ls.length,
      };
    });
  }, [lines, info, materialName, uomCode]);

  const anyAddl = rows.some((r) => r.addl > 0);
  const dp = (v: number) => fmtDecimal(v, v !== 0 && Math.abs(v) < 1 ? 3 : 2);

  return (
    <div className="card mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
        <h3 className="text-[13.5px] font-semibold text-slate-800">
          Total Requirement — {info.job_no} · {info.style_code} <span className="font-normal text-slate-500">(one line per material, plan-cut PCS incl. size-wise excess)</span>
        </h3>
        <span className="text-[11px] text-slate-500">Same figures as MRP and the PO / quotation BOM pick</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th rowSpan={2} className="th w-8">#</th>
              <th rowSpan={2} className="th">Type</th>
              <th rowSpan={2} className="th min-w-[170px]">Material</th>
              <th rowSpan={2} className="th">Colour</th>
              <th rowSpan={2} className="th">UOM</th>
              {info.sizes.length > 0 && <th colSpan={info.sizes.length} className="th border-l text-center">Consumption per PCS</th>}
              <th rowSpan={2} className="th text-right">Avg</th>
              <th rowSpan={2} className="th text-right">Waste %</th>
              {info.sizes.length > 0 && <th colSpan={info.sizes.length} className="th border-l text-center">Order qty (plan cut)</th>}
              <th rowSpan={2} className="th border-l text-right">Total PCS</th>
              <th rowSpan={2} className="th text-right">Base Qty</th>
              <th rowSpan={2} className="th text-right">Wastage Qty</th>
              {anyAddl && <th rowSpan={2} className="th text-right">Addl Qty</th>}
              <th rowSpan={2} className="th text-right text-brand-700">Total Required</th>
            </tr>
            <tr>
              {info.sizes.map((s, i) => <th key={`c${s.size_id}`} className={`th text-right ${i === 0 ? 'border-l' : ''}`}>{s.code}</th>)}
              {info.sizes.map((s, i) => <th key={`q${s.size_id}`} className={`th text-right ${i === 0 ? 'border-l' : ''}`}>{s.code}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const tone = TYPE_TONE[r.l0.material_type] ?? TYPE_TONE.GENERAL;
              return (
                <tr key={i} className={`border-t border-slate-100 ${tone.row}`}>
                  <td className={`td border-l-4 text-center text-slate-400 ${tone.bar}`}>{i + 1}</td>
                  <td className="td"><span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${tone.badge}`}>{r.l0.material_type}</span></td>
                  <td className="td">
                    <div className="font-semibold text-slate-900">{r.name}</div>
                    {(r.l0.specification || r.lineCount > 1) && (
                      <div className="text-[10.5px] text-slate-500">{[r.l0.specification, r.lineCount > 1 ? `${r.lineCount} BOM lines (size / colour wise)` : ''].filter(Boolean).join(' · ')}</div>
                    )}
                  </td>
                  <td className="td">{r.l0.color_id ? colorName(r.l0.color_id) : 'All'}</td>
                  <td className="td">{uomCode(r.l0.uom_id)}{r.l0.consumption_basis === 'PER_DOZEN' ? ' / dz' : r.fixed ? ' (fixed)' : ''}</td>
                  {r.perSize.map((p, k) => <td key={`c${k}`} className={`td text-right ${k === 0 ? 'border-l' : ''}`}>{r.fixed || p.cons == null ? <span className="text-slate-300">—</span> : dp(p.cons)}</td>)}
                  <td className="td text-right font-semibold">{dp(r.avg)}</td>
                  <td className="td text-right">{fmtDecimal(r.wastePct, 2)}{r.mixedWaste ? '*' : ''}</td>
                  {r.perSize.map((p, k) => <td key={`q${k}`} className={`td text-right ${k === 0 ? 'border-l' : ''}`}>{p.qty ? fmtNumber(p.qty) : <span className="text-slate-300">—</span>}</td>)}
                  <td className="td border-l text-right">{fmtNumber(r.orderQty)}</td>
                  <td className="td text-right">{dp(r.base)}</td>
                  <td className="td text-right">{dp(r.waste)}</td>
                  {anyAddl && <td className="td text-right">{r.addl ? dp(r.addl) : '—'}</td>}
                  <td className="td text-right font-bold text-brand-700">{dp(r.total)}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={12 + info.sizes.length * 2} className="td py-6 text-center text-slate-400">Enter materials with a consumption to see the requirement</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.mixedWaste) && <p className="px-4 py-2 text-[11px] text-slate-500">* the material's lines carry different wastage % — the weighted % is shown; each line's own % is used in the quantities.</p>}
    </div>
  );
}
