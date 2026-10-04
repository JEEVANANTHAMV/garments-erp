/**
 * Automatic lay calculation (CAD Marker → Automatic Lay Calculation developer doc §6, §7, §20; client voice notes
 * 04-Oct-2026: "the lay count comes automatically from the CAD marker; the user enters only the difference").
 *
 * Pure functions — no database. The routes feed them the cut order's size requirement and the approved markers.
 *
 *   pieces per marker (ppm)   = Σ ratio × layers            (a tubular marker cuts two layers per ply)
 *   pieces of a size per ply  = ratio × layers
 *   required marker units     = CEILING(pending ÷ ppm)
 *   plies for a marker        = COVER:   the size needing the most plies decides  (= the CAD "plies required")
 *                               NO_OVER: the size needing the fewest plies decides (no size is over-produced)
 *   lays                      = plies split by the max ply of the table (last lay = the remainder)
 *   lay output                = ppm × ply           fabric per lay = marker length × ply  (and KG/ply × ply)
 *
 * Cumulative size output is compared with the requirement; what is still short stays visible as the residual
 * and what is over beyond the tolerance is flagged (doc §7: never silently over-produce).
 */

export interface CalcMarker {
  marker_version_id: number;
  marker_no: string;
  version: number;
  sizes: string[];
  ratios: number[];
  pieces_per_marker: number;
  length_m: number | null;
  /** KG for one ply (KG markers) — null for metre markers. */
  kg_per_ply: number | null;
}

export interface LayRow {
  seq: number;
  marker_version_id: number;
  marker_no: string;
  version: number;
  ply: number;
  output: Record<string, number>;
  output_pcs: number;
  length_m: number | null;
  kg: number | null;
}

export interface SizeBalance {
  size: string;
  required: number;
  planned: number;
  /** still to plan (required − planned, never below 0) */
  residual: number;
  /** planned beyond the requirement */
  over: number;
  over_pct: number;
  over_tolerance: boolean;
}

export interface LayPlanResult {
  lays: LayRow[];
  markers: { marker_version_id: number; marker_no: string; version: number; ppm: number; plies: number; lays: number;
    required_marker_units: number; output_pcs: number }[];
  sizes: SizeBalance[];
  totals: { required: number; planned: number; residual: number; over: number; lays: number; plies: number;
    fabric_m: number | null; fabric_kg: number | null };
  warnings: string[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const key = (s: string) => String(s ?? '').trim().toUpperCase();

/** Pieces of each size cut by one ply of the marker. */
export function perPly(m: Pick<CalcMarker, 'sizes' | 'ratios' | 'pieces_per_marker'>): Record<string, number> {
  const sum = m.ratios.reduce((a, b) => a + (Number(b) || 0), 0);
  const layers = sum > 0 && m.pieces_per_marker > 0 ? m.pieces_per_marker / sum : 1;
  const out: Record<string, number> = {};
  m.sizes.forEach((sz, i) => { out[key(sz)] = (out[key(sz)] ?? 0) + (Number(m.ratios[i]) || 0) * layers; });
  return out;
}

/** Plies a marker needs for a requirement. */
export function pliesFor(m: CalcMarker, pending: Record<string, number>, strategy: 'COVER' | 'NO_OVER'): number {
  const pp = perPly(m);
  const asks = Object.entries(pp).filter(([, n]) => n > 0).map(([sz, n]) => ({ need: Math.max(0, pending[sz] ?? 0), n }));
  if (!asks.length) return 0;
  if (strategy === 'COVER') return Math.max(0, ...asks.map((a) => Math.ceil(a.need / a.n - 1e-9)));
  return Math.max(0, Math.min(...asks.map((a) => Math.floor(a.need / a.n + 1e-9))));
}

/**
 * Split plies over lays: full lays at the max ply, the remainder last. A remainder below the min ply is spread
 * evenly instead (e.g. 61 plies, max 60, min 10 → 31 + 30, not 60 + 1).
 */
export function splitPlies(total: number, maxPly: number, minPly = 1): number[] {
  if (total <= 0) return [];
  const max = Math.max(1, Math.floor(maxPly));
  const n = Math.ceil(total / max);
  const last = total - (n - 1) * max;
  if (n === 1 || last >= Math.max(1, minPly)) return [...Array(n - 1).fill(max), last];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

export function sizeBalances(required: Record<string, number>, planned: Record<string, number>, tolerancePct: number, order: string[] = []): SizeBalance[] {
  const sizes = [...new Set([...order.map(key), ...Object.keys(required), ...Object.keys(planned)])];
  return sizes.map((sz) => {
    const req = Math.max(0, required[sz] ?? 0);
    const pl = planned[sz] ?? 0;
    const over = Math.max(0, pl - req);
    const overPct = req > 0 ? (over / req) * 100 : (over > 0 ? 100 : 0);
    return { size: sz, required: req, planned: r3(pl), residual: r3(Math.max(0, req - pl)), over: r3(over), over_pct: Math.round(overPct * 100) / 100,
      over_tolerance: over > 0 && overPct > tolerancePct + 1e-9 };
  });
}

/**
 * Plan the lays for a requirement.
 *   requirement   pending PCS by size code (cut order target − already cut − already planned on open lays)
 *   markers       approved markers, in the order they should be used
 *   layPlies      optional user edits: explicit ply per lay ({ marker_version_id, ply }[]) — replaces the automatic split
 */
export function planLays(p: {
  requirement: Record<string, number>;
  markers: CalcMarker[];
  maxPly: number;
  minPly?: number;
  strategy?: 'COVER' | 'NO_OVER';
  tolerancePct?: number;
  sizeOrder?: string[];
  layPlies?: { marker_version_id: number; ply: number }[] | null;
}): LayPlanResult {
  const strategy = p.strategy ?? 'COVER';
  const tol = p.tolerancePct ?? 0;
  const warnings: string[] = [];
  const required: Record<string, number> = {};
  for (const [sz, q] of Object.entries(p.requirement)) required[key(sz)] = (required[key(sz)] ?? 0) + Math.max(0, Number(q) || 0);
  const pending = { ...required };
  const planned: Record<string, number> = {};
  const lays: LayRow[] = [];
  const markerSummary: LayPlanResult['markers'] = [];
  let seq = 0;

  const addLay = (m: CalcMarker, ply: number) => {
    const pp = perPly(m);
    const output: Record<string, number> = {};
    for (const [sz, n] of Object.entries(pp)) {
      const pcs = n * ply;
      if (pcs <= 0) continue;
      output[sz] = pcs;
      planned[sz] = (planned[sz] ?? 0) + pcs;
      pending[sz] = (pending[sz] ?? 0) - pcs;
    }
    lays.push({
      seq: ++seq, marker_version_id: m.marker_version_id, marker_no: m.marker_no, version: m.version, ply, output,
      output_pcs: m.pieces_per_marker * ply,
      length_m: m.length_m != null ? r3(m.length_m * ply) : null,
      kg: m.kg_per_ply != null ? r3(m.kg_per_ply * ply) : null,
    });
  };

  for (const m of p.markers) {
    if (!(m.pieces_per_marker > 0) || !m.sizes.length) {
      warnings.push(`Marker ${m.marker_no} v${m.version} has no size ratio — it cannot plan lays`);
      continue;
    }
    const before = lays.length;
    const pendingTotalBefore = Object.values(pending).reduce((a, b) => a + Math.max(0, b), 0);
    if (p.layPlies && p.layPlies.length) {
      for (const lp of p.layPlies.filter((x) => Number(x.marker_version_id) === m.marker_version_id)) {
        if (lp.ply > 0) addLay(m, Math.floor(lp.ply));
      }
    } else {
      const plies = pliesFor(m, pending, strategy);
      for (const ply of splitPlies(plies, p.maxPly, p.minPly ?? 1)) addLay(m, ply);
    }
    const mine = lays.slice(before);
    const plies = mine.reduce((a, l) => a + l.ply, 0);
    markerSummary.push({
      marker_version_id: m.marker_version_id, marker_no: m.marker_no, version: m.version, ppm: m.pieces_per_marker, plies,
      lays: mine.length, required_marker_units: Math.ceil(pendingTotalBefore / m.pieces_per_marker - 1e-9),
      output_pcs: mine.reduce((a, l) => a + l.output_pcs, 0),
    });
    if (p.layPlies?.length) {
      for (const l of mine) {
        if (l.ply > p.maxPly) warnings.push(`Lay ${l.seq}: ${l.ply} plies is more than the max ${p.maxPly} for the table`);
      }
    }
  }

  // Sizes the markers cannot cut at all.
  const cuttable = new Set(p.markers.flatMap((m) => Object.entries(perPly(m)).filter(([, n]) => n > 0).map(([sz]) => sz)));
  for (const [sz, q] of Object.entries(required)) {
    if (q > 0 && !cuttable.has(sz)) warnings.push(`Size ${sz} (${q} PCS) is on no selected marker — it stays as a residual`);
  }

  const sizes = sizeBalances(required, planned, tol, p.sizeOrder);
  for (const b of sizes) {
    if (b.over_tolerance) warnings.push(`Size ${b.size}: ${b.over} PCS over the requirement (${b.over_pct}% > ${tol}% tolerance)`);
  }
  const totReq = sizes.reduce((a, b) => a + b.required, 0);
  const totPlan = sizes.reduce((a, b) => a + b.planned, 0);
  const m = lays.every((l) => l.length_m != null) ? r3(lays.reduce((a, l) => a + (l.length_m ?? 0), 0)) : null;
  const kg = lays.every((l) => l.kg != null) ? r3(lays.reduce((a, l) => a + (l.kg ?? 0), 0)) : null;
  return {
    lays, markers: markerSummary, sizes,
    totals: {
      required: totReq, planned: r3(totPlan), residual: r3(sizes.reduce((a, b) => a + b.residual, 0)),
      over: r3(sizes.reduce((a, b) => a + b.over, 0)), lays: lays.length, plies: lays.reduce((a, l) => a + l.ply, 0),
      fabric_m: lays.length ? m : 0, fabric_kg: lays.length ? kg : 0,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ roll allocation (doc §8–§10) */

export interface AllocRoll {
  id: number; roll_no: string; lot_no: string | null; shade: string | null;
  available_kg: number; kg_per_m: number | null; fifo: string | number;
}
export interface AllocLine { fabric_roll_id: number; roll_no: string; lot_no: string | null; shade: string | null;
  alloc_kg: number; alloc_m: number | null; balance_kg: number }

/**
 * Pick rolls for a lay: same shade / lot first (one group that covers the whole lay), FIFO inside the group, the last
 * roll only partly (its balance stays on the roll). When no single shade / lot covers it, groups are combined in FIFO
 * order and the lay is flagged as mixed shade.
 */
export function allocateRolls(rolls: AllocRoll[], needKg: number): { lines: AllocLine[]; covered_kg: number; short_kg: number; mixed_shade: boolean; group: string | null } {
  const groupKey = (r: AllocRoll) => `${key(r.shade ?? '')}|${key(r.lot_no ?? '')}`;
  const usable = rolls.filter((r) => r.available_kg > 0.0005);
  const groups = new Map<string, AllocRoll[]>();
  for (const r of usable) groups.set(groupKey(r), [...(groups.get(groupKey(r)) ?? []), r]);
  const cmp = (a: AllocRoll, b: AllocRoll) => (a.fifo < b.fifo ? -1 : a.fifo > b.fifo ? 1 : a.id - b.id);
  const ordered = [...groups.entries()].map(([k, rs]) => ({ k, rs: rs.sort(cmp), total: rs.reduce((a, r) => a + r.available_kg, 0) }))
    .sort((a, b) => cmp(a.rs[0], b.rs[0]));
  const single = ordered.find((g) => g.total + 0.0005 >= needKg);
  const pool = single ? single.rs : ordered.flatMap((g) => g.rs);
  const lines: AllocLine[] = [];
  let left = needKg;
  for (const r of pool) {
    if (left <= 0.0005) break;
    const take = Math.min(r.available_kg, left);
    const kg = Math.round(take * 10000) / 10000;
    lines.push({ fabric_roll_id: r.id, roll_no: r.roll_no, lot_no: r.lot_no, shade: r.shade, alloc_kg: kg,
      alloc_m: r.kg_per_m ? r3(kg / r.kg_per_m) : null, balance_kg: Math.round((r.available_kg - kg) * 10000) / 10000 });
    left -= take;
  }
  const covered = lines.reduce((a, l) => a + l.alloc_kg, 0);
  const groupsUsed = new Set(lines.map((l) => `${key(l.shade ?? '')}|${key(l.lot_no ?? '')}`));
  return { lines, covered_kg: Math.round(covered * 10000) / 10000, short_kg: Math.max(0, Math.round((needKg - covered) * 10000) / 10000),
    mixed_shade: groupsUsed.size > 1, group: single ? single.k : null };
}
