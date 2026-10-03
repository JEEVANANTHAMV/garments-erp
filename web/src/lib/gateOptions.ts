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
