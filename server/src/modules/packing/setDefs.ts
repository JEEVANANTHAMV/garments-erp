/** Sets of a packing order (shared by packing and FG receipt — no imports, so neither imports the other). */
export interface SetComp { part: string; color_id: number; qty: number }
/**
 * A set of a packing order, known by its first part's colour (top_*). comps = every part with its colour and pieces per
 * set (client 29-Oct-2026: TOP 2 + BOTTOM 1, TOP + BOTTOM + DUPATTA); without comps it is TOP + BOTTOM 1:1 (16-Oct).
 */
export interface SetDef { top_part: string; top_color_id: number; bottom_part: string; bottom_color_id: number; comps?: SetComp[] }
export const setComps = (d: SetDef): SetComp[] => (d.comps?.length ? d.comps
  : [{ part: d.top_part, color_id: d.top_color_id, qty: 1 }, { part: d.bottom_part, color_id: d.bottom_color_id, qty: 1 }]);
/** A trx_packing_set row as a SetDef. */
export function setDefOfRow(r: any): SetDef {
  let comps: SetComp[] | undefined;
  try {
    const v = typeof r.components_json === 'string' ? JSON.parse(r.components_json) : r.components_json;
    if (Array.isArray(v) && v.length) comps = v.map((c: any) => ({ part: String(c.part).toUpperCase(), color_id: Number(c.color_id), qty: Number(c.qty) || 1 }));
  } catch { comps = undefined; }
  return { top_part: r.top_part, top_color_id: Number(r.top_color_id), bottom_part: r.bottom_part, bottom_color_id: Number(r.bottom_color_id), comps };
}
/** A set built from its parts (first part = the set colour). */
export const setDefOf = (comps: SetComp[]): SetDef => ({ top_part: comps[0].part, top_color_id: comps[0].color_id,
  bottom_part: comps[1]?.part ?? comps[0].part, bottom_color_id: comps[1]?.color_id ?? comps[0].color_id, comps });
