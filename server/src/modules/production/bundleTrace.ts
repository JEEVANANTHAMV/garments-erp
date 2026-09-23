import { query, queryOne } from '../../config/db.js';
import { bundleAvail } from './bundleLedger.js';

/**
 * Traceability chain (doc §23, §29):
 *   FABRIC ROLL → (DC roll) → LAY (lay rolls) → CUT OUTPUT → BUNDLE
 *     → sewing / finishing / QC / job-work DCs → CARTON → PACKING LIST → SHIPMENT
 * and back again. Every hop follows a stored FK; nothing is inferred from
 * IO numbers.
 */

const ids = (rows: any[], key = 'id') => [...new Set(rows.map((r) => Number(r[key])).filter(Boolean))];
const none = (a: unknown[]) => a.length === 0;

const BUNDLE_SELECT = `
  SELECT cb.*, st.style_code, st.style_name, col.color_name, sz.size_code,
         c.cut_no, c.cut_date,
         lp.id AS trace_lay_id, lp.lay_no, lp.lay_date, lp.status AS lay_status, lp.marker_ref,
         lp.actual_kg AS lay_actual_kg, lp.ply_count, lp.table_no,
         mv.marker_no, mv.version AS marker_version, mv.marker_name,
         co.output_no, co.good_qty AS cut_output_good_qty, co.kg_per_pc AS cut_output_kg_per_pc,
         cp.id AS trace_cutting_plan_id, cp.plan_no, cp.status AS plan_status,
         pb.bundle_no AS parent_bundle_no, pb.barcode AS parent_barcode
    FROM trx_cutting_bundle cb
    LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
    LEFT JOIN trx_lay_plan lp ON lp.id = COALESCE(cb.lay_id, c.lay_id)
    LEFT JOIN trx_cut_output co ON co.id = cb.cut_output_id
    LEFT JOIN trx_marker_version mv ON mv.id = COALESCE(cb.marker_version_id, lp.marker_version_id)
    LEFT JOIN trx_cutting_plan cp ON cp.id = COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id)
    LEFT JOIN trx_cutting_bundle pb ON pb.id = cb.parent_bundle_id
    LEFT JOIN mst_style st ON st.id = cb.style_id
    LEFT JOIN mst_color col ON col.id = cb.color_id
    LEFT JOIN mst_size sz ON sz.id = cb.size_id`;

const BUNDLE_SCOPE = `COALESCE(cb.company_id, c.company_id) = ?`;

/** Fabric rolls of a set of lays with their DC, lot, GRN and PO. */
async function laySources(cid: number, layIds: number[]) {
  if (none(layIds)) return [];
  const rows = await query(
    `SELECT lr.id AS lay_roll_id, lr.lay_id, lp.lay_no, lr.fabric_roll_id, lr.fabric_issue_roll_id,
            COALESCE(fr.roll_no, lr.roll_no) AS roll_no, COALESCE(fr.lot_no, lr.lot_no) AS lot_no,
            lr.plies, lr.before_kg, lr.after_kg, lr.actual_consumed_kg,
            fr.weight_kg AS roll_kg, fr.shade, fr.gsm, fr.dia, fb.fabric_name,
            fi.id AS fabric_issue_id, fi.issue_no AS dc_no, fi.issue_date AS dc_date,
            g.id AS grn_id, g.grn_no, g.grn_date, sup.party_name AS supplier_name,
            po.id AS po_id, po.po_no, po.po_date
       FROM trx_lay_roll lr
       JOIN trx_lay_plan lp ON lp.id = lr.lay_id
       LEFT JOIN trx_fabric_roll fr ON fr.id = lr.fabric_roll_id
       LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN trx_fabric_issue_roll fir ON fir.id = lr.fabric_issue_roll_id
       LEFT JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
       LEFT JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id)
       LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      WHERE lr.lay_id IN (?) AND lr.company_id = ?
      ORDER BY lr.lay_id, lr.id`, [layIds, cid]);
  return rows;
}

/** Cartons, packing, packing lists and shipments holding a set of bundles. */
async function bundleDestinations(cid: number, bundleIds: number[]) {
  if (none(bundleIds)) return [];
  return query(
    `SELECT ctb.bundle_id, ctb.qty AS packed_qty, ct.id AS carton_id, ct.carton_no, ct.barcode AS carton_barcode,
            p.id AS packing_id, p.pack_no, pl.id AS packing_list_id, pl.pl_no, pl.status AS pl_status,
            sh.id AS shipment_id, sh.shipment_no, sh.etd, sh.destination
       FROM trx_carton_bundle ctb
       JOIN trx_carton ct ON ct.id = ctb.carton_id
       JOIN trx_packing p ON p.id = ct.packing_id
       LEFT JOIN trx_packing_list pl ON pl.packing_id = p.id AND pl.company_id = p.company_id
       LEFT JOIN trx_shipment_package sp ON sp.carton_id = ct.id AND sp.status <> 'CANCELLED'
       LEFT JOIN trx_shipment sh ON sh.id = COALESCE(sp.shipment_id,
            (SELECT s2.id FROM trx_shipment s2 WHERE s2.packing_list_id = pl.id AND s2.company_id = p.company_id ORDER BY s2.id LIMIT 1))
      WHERE ctb.bundle_id IN (?) AND p.company_id = ?
      ORDER BY ct.carton_no`, [bundleIds, cid]);
}

/** Full upstream + downstream picture of one bundle (scan screen, doc §14). */
export async function buildBundleTrace(cid: number, bundleId: number, strictQc = false) {
  const bundle = await queryOne<any>(`${BUNDLE_SELECT} WHERE cb.id = ? AND ${BUNDLE_SCOPE}`, [bundleId, cid]);
  if (!bundle) return null;
  const layId = Number(bundle.trace_lay_id) || null;

  const [rolls, children, mergeSources, mergedInto, components, history, sewing, finishing, finalQc, dcs, packed] =
    await Promise.all([
      laySources(cid, layId ? [layId] : []),
      query(`SELECT id, bundle_no, barcode, qty, balance_qty, status, allocated_kg FROM trx_cutting_bundle
              WHERE parent_bundle_id = ? ORDER BY id`, [bundleId]),
      query(`SELECT ms.source_bundle_id, ms.qty, ms.allocated_kg, ms.reason, sb.bundle_no, sb.barcode
               FROM trx_bundle_merge_source ms JOIN trx_cutting_bundle sb ON sb.id = ms.source_bundle_id
              WHERE ms.merged_bundle_id = ? AND ms.company_id = ?`, [bundleId, cid]),
      query(`SELECT ms.merged_bundle_id, ms.qty, mb.bundle_no, mb.barcode
               FROM trx_bundle_merge_source ms JOIN trx_cutting_bundle mb ON mb.id = ms.merged_bundle_id
              WHERE ms.source_bundle_id = ? AND ms.company_id = ?`, [bundleId, cid]),
      query(`SELECT component, piece_qty FROM trx_cutting_bundle_detail WHERE bundle_id = ?`, [bundleId]),
      query(`SELECT bm.id, bm.txn_type, bm.from_stage, bm.to_stage, bm.moved_qty, bm.good_qty, bm.reject_qty,
                    bm.rework_qty, bm.location, bm.work_center, bm.destination, bm.ref_table, bm.ref_id,
                    bm.remarks, bm.moved_at, u.full_name AS moved_by_name
               FROM trx_bundle_movement bm LEFT JOIN mst_user u ON u.id = bm.moved_by
              WHERE bm.bundle_id = ? AND bm.company_id = ? ORDER BY bm.moved_at, bm.id`, [bundleId, cid]),
      query(`SELECT si.id, si.input_no, si.input_date, si.line_name, si.input_qty, si.status,
                    COALESCE(SUM(so.output_qty),0) AS good_qty, COALESCE(SUM(so.reject_qty),0) AS reject_qty
               FROM trx_sewing_input si LEFT JOIN trx_sewing_output so ON so.sewing_input_id = si.id
              WHERE si.bundle_id = ? AND si.company_id = ? GROUP BY si.id ORDER BY si.id`, [bundleId, cid]),
      query(`SELECT fi.id, fi.input_no, fi.input_date, fi.line_name, fi.input_qty, fi.status,
                    COALESCE(SUM(fo.output_qty),0) AS good_qty, COALESCE(SUM(fo.reject_qty),0) AS reject_qty
               FROM trx_finishing_input fi LEFT JOIN trx_finishing_output fo ON fo.finishing_input_id = fi.id
              WHERE fi.bundle_id = ? AND fi.company_id = ? GROUP BY fi.id ORDER BY fi.id`, [bundleId, cid]),
      query(`SELECT id, qc_no, qc_date, inspected_qty, passed_qty, reject_qty, rework_qty, hold_qty, qc_status, inspector_name
               FROM trx_final_qc WHERE bundle_id = ? AND company_id = ? ORDER BY id`, [bundleId, cid]),
      query(`SELECT jl.id AS line_id, jc.id AS challan_id, jc.challan_no, jc.challan_date, jc.status, ps.stage_name,
                    v.party_name AS vendor_name, jl.qty, jl.received_qty, jl.rejected_qty, jl.shortage_qty
               FROM trx_jobwork_challan_line jl
               JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
               LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
               LEFT JOIN mst_party v ON v.id = jc.vendor_id
              WHERE jl.bundle_id = ? AND jc.company_id = ? ORDER BY jc.id`, [bundleId, cid]),
      bundleDestinations(cid, [bundleId]),
    ]);

  return {
    ...bundle,
    lay_id: bundle.lay_id ?? layId,
    cutting_plan_id: bundle.trace_cutting_plan_id,
    avail: bundleAvail(bundle, strictQc),
    fabric_rolls: rolls,
    lots: [...new Set(rolls.map((r: any) => r.lot_no).filter(Boolean))],
    children, merge_sources: mergeSources, merged_into: mergedInto,
    components, history, sewing, finishing, final_qc: finalQc, dcs,
    cartons: packed,
    current_carton: packed[0] ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Chain expansion for roll / lot / carton / shipment traces
// ─────────────────────────────────────────────────────────────────────

async function bundlesByIds(cid: number, bundleIds: number[]) {
  if (none(bundleIds)) return [];
  const rows = await query(`${BUNDLE_SELECT} WHERE cb.id IN (?) AND ${BUNDLE_SCOPE} ORDER BY cb.id`, [bundleIds, cid]);
  return rows.map((b: any) => ({ ...b, avail: bundleAvail(b) }));
}

/** Add split children / merged bundles (downstream) until stable. */
async function withDescendants(cid: number, start: number[]) {
  const seen = new Set(start);
  let frontier = start;
  for (let i = 0; i < 10 && frontier.length; i++) {
    const [kids, merged] = await Promise.all([
      query(`SELECT id FROM trx_cutting_bundle WHERE parent_bundle_id IN (?)`, [frontier]),
      query(`SELECT merged_bundle_id AS id FROM trx_bundle_merge_source WHERE source_bundle_id IN (?) AND company_id = ?`, [frontier, cid]),
    ]);
    frontier = ids([...kids, ...merged]).filter((x) => !seen.has(x));
    frontier.forEach((x) => seen.add(x));
  }
  return [...seen];
}

/** Add split parents / merge sources (upstream) until stable. */
async function withAncestors(cid: number, start: number[]) {
  const seen = new Set(start);
  let frontier = start;
  for (let i = 0; i < 10 && frontier.length; i++) {
    const [parents, sources] = await Promise.all([
      query(`SELECT parent_bundle_id AS id FROM trx_cutting_bundle WHERE id IN (?) AND parent_bundle_id IS NOT NULL`, [frontier]),
      query(`SELECT source_bundle_id AS id FROM trx_bundle_merge_source WHERE merged_bundle_id IN (?) AND company_id = ?`, [frontier, cid]),
    ]);
    frontier = ids([...parents, ...sources]).filter((x) => !seen.has(x));
    frontier.forEach((x) => seen.add(x));
  }
  return [...seen];
}

function summarise(bundles: any[]) {
  const t = { bundles: bundles.length, cut_pcs: 0, sewn_pcs: 0, finished_pcs: 0, qc_passed_pcs: 0, packed_pcs: 0, rejected_pcs: 0, allocated_kg: 0 };
  for (const b of bundles) {
    if (b.status === 'SPLIT' || b.status === 'CLOSED') continue;   // counted in their children / merged bundle
    t.cut_pcs += Number(b.qty) || 0;
    t.sewn_pcs += Number(b.sew_good_qty) || 0;
    t.finished_pcs += Number(b.fin_good_qty) || 0;
    t.qc_passed_pcs += Number(b.qc_pass_qty) || 0;
    t.packed_pcs += Number(b.packed_qty) || 0;
    t.rejected_pcs += b.avail?.rejected || 0;
    t.allocated_kg += Number(b.allocated_kg) || 0;
  }
  t.allocated_kg = Math.round(t.allocated_kg * 1000) / 1000;
  return t;
}

async function lotsGrnsPos(rolls: any[]) {
  const grns = new Map<number, any>(); const pos = new Map<number, any>(); const lots = new Set<string>();
  for (const r of rolls) {
    if (r.lot_no) lots.add(r.lot_no);
    if (r.grn_id) grns.set(r.grn_id, { id: r.grn_id, grn_no: r.grn_no, grn_date: r.grn_date, supplier_name: r.supplier_name });
    if (r.po_id) pos.set(r.po_id, { id: r.po_id, po_no: r.po_no, po_date: r.po_date });
  }
  return { lots: [...lots], grns: [...grns.values()], pos: [...pos.values()] };
}

/** Forward trace: fabric roll no or lot no → … → shipment. */
export async function traceForwardFromFabric(cid: number, by: { roll?: string; lot?: string }) {
  const rollRows = await query(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.weight_kg, fr.issued_kg, fr.stock_status, fr.shade, fb.fabric_name,
            g.id AS grn_id, g.grn_no, g.grn_date, sup.party_name AS supplier_name, po.id AS po_id, po.po_no, po.po_date
       FROM trx_fabric_roll fr
       LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id)
       LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      WHERE fr.company_id = ? AND ${by.roll ? 'fr.roll_no = ?' : 'fr.lot_no = ?'}`, [cid, by.roll ?? by.lot]);
  const rollIds = ids(rollRows);

  // DC rolls: linked by roll stock id, or (legacy rows) by roll/lot no text.
  const dcRolls = await query(
    `SELECT fir.id, fir.fabric_roll_id, fir.roll_no, fir.lot_no, fir.issue_kg, fir.consumed_kg, fir.returned_kg, fir.roll_status,
            fi.id AS fabric_issue_id, fi.issue_no, fi.issue_date, fi.io_no, fi.status
       FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE fi.company_id = ? AND (${none(rollIds) ? '0' : 'fir.fabric_roll_id IN (?)'}
            OR (fir.fabric_roll_id IS NULL AND ${by.roll ? 'fir.roll_no = ?' : 'fir.lot_no = ?'}))`,
    none(rollIds) ? [cid, by.roll ?? by.lot] : [cid, rollIds, by.roll ?? by.lot]);
  const dcRollIds = ids(dcRolls);

  const layRolls = await query(
    `SELECT lr.lay_id FROM trx_lay_roll lr
      WHERE lr.company_id = ? AND (${none(rollIds) ? '0' : 'lr.fabric_roll_id IN (?)'}
            OR ${none(dcRollIds) ? '0' : 'lr.fabric_issue_roll_id IN (?)'}
            OR (lr.fabric_roll_id IS NULL AND ${by.roll ? 'lr.roll_no = ?' : 'lr.lot_no = ?'}))`,
    [cid, ...(none(rollIds) ? [] : [rollIds]), ...(none(dcRollIds) ? [] : [dcRollIds]), by.roll ?? by.lot]);
  const layIds = ids(layRolls, 'lay_id');
  const { lots, grns, pos } = await lotsGrnsPos(rollRows);
  return expandFromLays(cid, layIds, {
    direction: 'FORWARD', root: { type: by.roll ? 'ROLL' : 'LOT', key: by.roll ?? by.lot },
    rolls: rollRows, dcRolls, lots, grns, pos,
  });
}

async function expandFromLays(cid: number, layIds: number[], base: Record<string, any>) {
  const [lays, cutOutputs] = none(layIds) ? [[], []] : await Promise.all([
    query(`SELECT lp.id, lp.lay_no, lp.lay_date, lp.status, lp.actual_kg, lp.actual_cut_qty, lp.ply_count,
                  lp.marker_ref, cp.id AS cutting_plan_id, cp.plan_no
             FROM trx_lay_plan lp LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
            WHERE lp.id IN (?) AND lp.company_id = ?`, [layIds, cid]),
    query(`SELECT co.id, co.output_no, co.lay_id, co.good_qty, co.reject_qty, co.actual_kg, co.bundled_qty, sz.size_code
             FROM trx_cut_output co LEFT JOIN mst_size sz ON sz.id = co.size_id
            WHERE co.lay_id IN (?) AND co.company_id = ?`, [layIds, cid]),
  ]);
  let bundleIds: number[] = [];
  if (!none(layIds)) {
    const rows = await query(
      `SELECT cb.id FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
        WHERE (cb.lay_id IN (?) OR (cb.lay_id IS NULL AND c.lay_id IN (?))) AND ${BUNDLE_SCOPE}`, [layIds, layIds, cid]);
    bundleIds = await withDescendants(cid, ids(rows));
  }
  const bundles = await bundlesByIds(cid, bundleIds);
  const dest = await bundleDestinations(cid, bundleIds);
  return assemble({ ...base, lays, cutOutputs, bundles, dest });
}

function assemble(x: Record<string, any>): Record<string, any> {
  const dest: any[] = x.dest ?? [];
  const uniq = (rows: any[], key: string, pick: (r: any) => any) => {
    const m = new Map<any, any>();
    for (const r of rows) if (r[key] && !m.has(r[key])) m.set(r[key], pick(r));
    return [...m.values()];
  };
  const cartons = uniq(dest, 'carton_id', (r) => ({
    id: r.carton_id, carton_no: r.carton_no, barcode: r.carton_barcode, pack_no: r.pack_no,
    pcs: dest.filter((d) => d.carton_id === r.carton_id).reduce((s, d) => s + Number(d.packed_qty || 0), 0),
    bundle_ids: dest.filter((d) => d.carton_id === r.carton_id).map((d) => d.bundle_id),
    shipment_no: r.shipment_no, pl_no: r.pl_no,
  }));
  const packingLists = uniq(dest, 'packing_list_id', (r) => ({ id: r.packing_list_id, pl_no: r.pl_no, status: r.pl_status, pack_no: r.pack_no }));
  const shipments = x.shipments ?? uniq(dest, 'shipment_id', (r) => ({ id: r.shipment_id, shipment_no: r.shipment_no, etd: r.etd, destination: r.destination }));
  const { dest: _d, ...rest } = x;
  return {
    ...rest,
    cartons: x.cartons ?? cartons,
    packingLists: x.packingLists ?? packingLists,
    shipments,
    summary: summarise(x.bundles ?? []),
  };
}

/** Backward trace from a set of bundles (carton / shipment start). */
async function traceBackFromBundles(cid: number, startBundleIds: number[], base: Record<string, any>) {
  const allIds = await withAncestors(cid, startBundleIds);
  const bundles = await bundlesByIds(cid, allIds);
  const layIds = ids(bundles, 'trace_lay_id');
  const [rolls, lays] = await Promise.all([
    laySources(cid, layIds),
    none(layIds) ? [] : query(
      `SELECT lp.id, lp.lay_no, lp.lay_date, lp.status, lp.actual_kg, lp.actual_cut_qty, lp.marker_ref,
              cp.id AS cutting_plan_id, cp.plan_no
         FROM trx_lay_plan lp LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
        WHERE lp.id IN (?) AND lp.company_id = ?`, [layIds, cid]),
  ]);
  const { lots, grns, pos } = await lotsGrnsPos(rolls);
  return assemble({ ...base, bundles, lays, rolls, lots, grns, pos });
}

export async function traceBackFromCarton(cid: number, code: string) {
  const carton = await queryOne<any>(
    `SELECT ct.*, p.pack_no, p.io_no, p.id AS packing_id FROM trx_carton ct JOIN trx_packing p ON p.id = ct.packing_id
      WHERE (ct.carton_no = ? OR ct.barcode = ?) AND p.company_id = ? ORDER BY (ct.barcode = ?) DESC, ct.id DESC LIMIT 1`,
    [code, code, cid, code]);
  if (!carton) return null;
  const links = await query(`SELECT bundle_id FROM trx_carton_bundle WHERE carton_id = ?`, [carton.id]);
  const [pls, ships] = await Promise.all([
    query(`SELECT id, pl_no, status FROM trx_packing_list WHERE packing_id = ? AND company_id = ?`, [carton.packing_id, cid]),
    query(`SELECT DISTINCT sh.id, sh.shipment_no, sh.etd, sh.destination
             FROM trx_shipment sh
             LEFT JOIN trx_shipment_package sp ON sp.shipment_id = sh.id AND sp.status <> 'CANCELLED'
             LEFT JOIN trx_packing_list pl ON pl.id = sh.packing_list_id
            WHERE sh.company_id = ? AND (sp.carton_id = ? OR pl.packing_id = ?)`, [cid, carton.id, carton.packing_id]),
  ]);
  return traceBackFromBundles(cid, ids(links, 'bundle_id'), {
    direction: 'BACKWARD', root: { type: 'CARTON', key: carton.carton_no },
    cartons: [{ id: carton.id, carton_no: carton.carton_no, barcode: carton.barcode, pack_no: carton.pack_no,
                bundle_ids: ids(links, 'bundle_id') }],
    packingLists: pls, shipments: ships,
  });
}

export async function traceBackFromShipment(cid: number, code: string) {
  const sh = await queryOne<any>(
    `SELECT id, shipment_no, etd, destination, packing_list_id FROM trx_shipment WHERE shipment_no = ? AND company_id = ?`, [code, cid]);
  if (!sh) return null;
  // Cartons: allocated shipment packages, else every carton of the linked packing list.
  let cartons = await query(
    `SELECT ct.id, ct.carton_no, ct.barcode, p.pack_no FROM trx_shipment_package sp
       JOIN trx_carton ct ON ct.id = sp.carton_id JOIN trx_packing p ON p.id = ct.packing_id
      WHERE sp.shipment_id = ? AND sp.status <> 'CANCELLED' AND p.company_id = ?`, [sh.id, cid]);
  const pls = sh.packing_list_id
    ? await query(`SELECT id, pl_no, status, packing_id FROM trx_packing_list WHERE id = ? AND company_id = ?`, [sh.packing_list_id, cid])
    : [];
  if (!cartons.length && pls[0]?.packing_id) {
    cartons = await query(
      `SELECT ct.id, ct.carton_no, ct.barcode, p.pack_no FROM trx_carton ct JOIN trx_packing p ON p.id = ct.packing_id
        WHERE ct.packing_id = ? AND p.company_id = ?`, [pls[0].packing_id, cid]);
  }
  const cartonIds = ids(cartons);
  const links = none(cartonIds) ? [] : await query(
    `SELECT carton_id, bundle_id, qty FROM trx_carton_bundle WHERE carton_id IN (?)`, [cartonIds]);
  for (const c of cartons as any[]) {
    const l = links.filter((x: any) => x.carton_id === c.id);
    c.bundle_ids = l.map((x: any) => x.bundle_id);
    c.pcs = l.reduce((s: number, x: any) => s + Number(x.qty || 0), 0);
  }
  return traceBackFromBundles(cid, ids(links, 'bundle_id'), {
    direction: 'BACKWARD', root: { type: 'SHIPMENT', key: sh.shipment_no },
    cartons, packingLists: pls, shipments: [{ id: sh.id, shipment_no: sh.shipment_no, etd: sh.etd, destination: sh.destination }],
  });
}

/** Bundle as the trace root: both directions. */
export async function traceBundleBothWays(cid: number, bundleId: number) {
  const up = await withAncestors(cid, [bundleId]);
  const down = await withDescendants(cid, [bundleId]);
  const all = [...new Set([...up, ...down])];
  const bundles = await bundlesByIds(cid, all);
  const layIds = ids(bundles, 'trace_lay_id');
  const [rolls, dest] = await Promise.all([laySources(cid, layIds), bundleDestinations(cid, down)]);
  const { lots, grns, pos } = await lotsGrnsPos(rolls);
  const root = bundles.find((b: any) => b.id === bundleId);
  return assemble({
    direction: 'BOTH', root: { type: 'BUNDLE', key: root?.barcode ?? root?.bundle_no },
    bundles, rolls, lots, grns, pos, dest,
    lays: bundles.filter((b: any) => b.trace_lay_id).reduce((m: any[], b: any) =>
      m.some((l) => l.id === b.trace_lay_id) ? m : [...m, { id: b.trace_lay_id, lay_no: b.lay_no, status: b.lay_status, plan_no: b.plan_no, cutting_plan_id: b.trace_cutting_plan_id }], []),
  });
}
