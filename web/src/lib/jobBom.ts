import { useCallback, useEffect, useRef, useState } from 'react';
import { http } from './api';

/**
 * Line-level "pick from the job's BOM" for quotations and POs: each line may carry its own
 * job (IO) + style, so the BOM of every (job, style) used on the document is fetched once
 * from /boms/for-job and kept here. Items carry the requirement (final_requirement), colour,
 * size, spec and UOM exactly as "Load from BOM" fills whole documents.
 */
export interface JobBomItem {
  bom_line_id: number; material_type: string; so_id: number | null; style_id: number; job_no: string | null;
  fabric_id?: number | null; yarn_id?: number | null; trim_id?: number | null;
  material_name?: string; item_description?: string | null; specification?: string | null;
  color_id?: number | null; color_name?: string | null; size_id?: number | null; size_code?: string | null;
  uom_id?: number | null; uom_code?: string | null; final_requirement?: number; order_required_qty?: number;
  std_rate?: number | string | null; [k: string]: any;
}

const keyOf = (soId: unknown, styleId: unknown) => `${Number(soId) || 0}:${Number(styleId) || 0}`;

export function useJobBoms(pairs: { so_id: unknown; style_id: unknown }[]) {
  const [cache, setCache] = useState<Record<string, JobBomItem[] | 'loading' | 'none'>>({});
  const asked = useRef(new Set<string>());
  const wanted = pairs.filter((p) => Number(p.so_id) > 0 && Number(p.style_id) > 0).map((p) => keyOf(p.so_id, p.style_id));
  const sig = [...new Set(wanted)].sort().join(',');

  useEffect(() => {
    for (const k of sig ? sig.split(',') : []) {
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      const [so, st] = k.split(':');
      setCache((c) => ({ ...c, [k]: 'loading' }));
      http.get<{ data: any }>(`/boms/for-job?so_id=${so}&style_id=${st}`)
        .then((r) => setCache((c) => ({ ...c, [k]: (r.data?.lines ?? []) as JobBomItem[] })))
        .catch(() => setCache((c) => ({ ...c, [k]: 'none' })));
    }
  }, [sig]);

  /** BOM items of a line's job + style (empty while loading / when there is no BOM). */
  const itemsFor = useCallback((soId: unknown, styleId: unknown, types?: string[]) => {
    const v = cache[keyOf(soId, styleId)];
    if (!Array.isArray(v)) return [] as JobBomItem[];
    return types ? v.filter((it) => types.includes(it.material_type)) : v;
  }, [cache]);
  const statusFor = useCallback((soId: unknown, styleId: unknown) => {
    const v = cache[keyOf(soId, styleId)];
    return Array.isArray(v) ? (v.length ? 'ready' : 'empty') : v ?? 'idle';
  }, [cache]);

  return { itemsFor, statusFor };
}

/** Option label of a BOM item: material · spec · colour · size — required qty UOM. */
export function bomItemLabel(it: JobBomItem) {
  const qty = Number(it.final_requirement ?? it.order_required_qty) || 0;
  const bits = [it.material_name || it.item_description, it.specification, it.color_name, it.size_code].filter(Boolean);
  return `${bits.join(' · ')} — ${qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${it.uom_code || ''}`.trim();
}
