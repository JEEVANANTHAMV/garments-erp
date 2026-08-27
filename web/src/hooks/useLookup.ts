import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';

export interface LookupItem {
  id: number; code?: string | number; label: string;
  [k: string]: unknown;
}

/**
 * Cached dropdown options. Lookups change rarely, so they are held for
 * 10 minutes and shared across every form that needs them.
 */
export function useLookup(name: string | null, enabled = true) {
  return useQuery({
    queryKey: ['lookup', name],
    queryFn: async () => (await http.get<{ data: LookupItem[] }>(`/lookups/${name}`)).data,
    enabled: !!name && enabled,
    staleTime: 15 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

/** Sizes belonging to one size group. */
export function useSizes(groupId?: number | null) {
  return useQuery({
    queryKey: ['lookup', 'sizes', groupId],
    queryFn: async () => (await http.get<{ data: LookupItem[] }>(`/lookups/sizes/${groupId}`)).data,
    enabled: !!groupId,
    staleTime: 10 * 60 * 1000,
  });
}

/** Status options for a workflow domain (SALES_ORDER, QC, …).
 *  Pass an empty string to skip the fetch (returns empty array). */
export function useStatuses(domain: string) {
  return useQuery({
    queryKey: ['lookup', 'statuses', domain],
    queryFn: async () => (await http.get<{ data: LookupItem[] }>(`/lookups/statuses/${domain}`)).data,
    enabled: !!domain,           // ← never fire with empty string
    staleTime: 30 * 60 * 1000,
  });
}

export interface StyleSku {
  id: number; sku_code: string; barcode: string | null;
  color_id: number; size_id: number; color_name: string; hex_value: string | null;
  size_code: string; size_label: string; sort_order: number;
}

export function useStyleSkus(styleId?: number | null) {
  return useQuery({
    queryKey: ['lookup', 'style-skus', styleId],
    queryFn: async () => (await http.get<{ data: StyleSku[] }>(`/lookups/style-skus/${styleId}`)).data,
    enabled: !!styleId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useStyleColors(styleId?: number | null) {
  return useQuery({
    queryKey: ['lookup', 'style-colors', styleId],
    queryFn: async () => (await http.get<{ data: LookupItem[] }>(`/lookups/style-colors/${styleId}`)).data,
    enabled: !!styleId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Turn lookup rows into <Select options={...}> shape. */
export const toOptions = (items?: LookupItem[]) =>
  (items ?? []).map((i) => ({ value: i.id, label: i.code ? `${i.code} — ${i.label}` : i.label }));

export const toPlainOptions = (items?: LookupItem[]) =>
  (items ?? []).map((i) => ({ value: i.id, label: i.label }));
