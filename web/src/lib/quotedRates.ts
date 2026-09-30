import { useQuery } from '@tanstack/react-query';
import { http } from './api';

/**
 * Rates a supplier quoted (GET /procurement/quoted-rates) for the PO pages: a PO line filled
 * from the BOM or picked by hand takes the quotation's CONFIRMED rate (else its quotation rate)
 * and its GST %, instead of the material's standard rate and the page's default GST.
 */
export interface QuotedRate {
  quotation_id: number; quotation_no: string; quotation_line_id: number;
  bom_line_id: number | null; material_id: number; color_id: number | null; size_id: number | null; so_id: number | null;
  rate: number; confirm_rate: number; quotation_rate: number; gst_rate: number;
}

export function useQuotedRates(kind: 'FABRIC' | 'YARN' | 'TRIMS', supplierId: unknown) {
  const sid = Number(supplierId) || 0;
  return useQuery({
    queryKey: ['quoted-rates', kind, sid],
    queryFn: async () => (await http.get<{ data: QuotedRate[] }>(`/procurement/quoted-rates?kind=${kind}&supplier_id=${sid}`)).data ?? [],
    enabled: sid > 0,
    staleTime: 30 * 1000,
  });
}

/**
 * Best quoted line for a PO line: same BOM line first, then same material with the same
 * colour / size / job, relaxing colour / size / job in that order. Rows arrive latest first.
 */
export function matchQuote(quotes: QuotedRate[] | undefined, p: {
  bom_line_id?: unknown; material_id: unknown; color_id?: unknown; size_id?: unknown; so_id?: unknown;
}): QuotedRate | null {
  if (!quotes?.length || !Number(p.material_id)) return null;
  const mat = Number(p.material_id);
  const same = (a: unknown, b: number | null) => (Number(a) || null) === b;
  const bl = Number(p.bom_line_id) || 0;
  if (bl) {
    const hit = quotes.find((q) => q.bom_line_id === bl && q.material_id === mat);
    if (hit) return hit;
  }
  const mats = quotes.filter((q) => q.material_id === mat);
  const tiers: ((q: QuotedRate) => boolean)[] = [
    (q) => same(p.so_id, q.so_id) && same(p.color_id, q.color_id) && same(p.size_id, q.size_id),
    (q) => same(p.so_id, q.so_id) && same(p.color_id, q.color_id),
    (q) => same(p.so_id, q.so_id),
    (q) => !q.so_id || same(p.so_id, q.so_id),
    () => true,
  ];
  for (const t of tiers) {
    const hit = mats.find(t);
    if (hit) return hit;
  }
  return null;
}
