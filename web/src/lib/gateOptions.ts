/**
 * Gate entries a GRN may map: only the supplier's own entries (once the supplier is known — before that only open
 * ones), never cancelled / rejected; an entry already mapped to a GRN is marked. The server checks the same
 * (useGateEntry: the entry must be the GRN supplier's).
 */
export function gateOptions(list: any[] | undefined, supplierId: unknown, selected?: unknown) {
  const sup = String(supplierId ?? '');
  return (list ?? [])
    .filter((g) => String(g.id) === String(selected ?? '-') || (!['REJECTED', 'CANCELLED'].includes(g.status)
      && (sup ? String(g.party_id ?? '') === sup : g.status !== 'GRN_COMPLETED')))
    .map((g) => ({ ...g, value: g.id, label: `${g.code || g.label}${g.vehicle_no ? ` (${g.vehicle_no})` : ''}${g.supplier_dc_no ? ` · DC ${g.supplier_dc_no}` : ''}${g.status === 'GRN_COMPLETED' ? ' · already mapped' : ''}` }));
}

/**
 * Supplier options of a GRN: the supplier list, plus the PO's supplier when that party is not marked as a supplier
 * in the party master (otherwise the field would show blank although the GRN carries it).
 */
export function supplierOptions(suppliers: any[] | undefined, current: unknown, pos: any[] | undefined) {
  const opts = (suppliers ?? []).map((s) => ({ value: s.id, label: s.code ? `${s.code} — ${s.label}` : s.label }));
  const cur = String(current ?? '');
  if (cur && !opts.some((o) => String(o.value) === cur)) {
    const name = (pos ?? []).find((p) => String(p.supplier_id) === cur)?.supplier_name;
    opts.unshift({ value: Number(cur), label: `${name ?? `Party #${cur}`} (not marked as supplier)` });
  }
  return opts;
}
