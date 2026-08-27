import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http, type ListResponse, type ItemResponse } from '../lib/api';
import { useToast } from './useToast';
import { ApiError } from '../lib/api';

/** Generic list query against any REST resource exposed by the API. */
export function useList<T>(path: string, params: Record<string, unknown>, enabled = true) {
  return useQuery({
    queryKey: [path, params],
    queryFn: async () => await http.get<ListResponse<T>>(`/${path}`, params),
    enabled,
    placeholderData: (prev) => prev,   // keeps the table populated while paging
  });
}

export function useItem<T>(path: string, id?: number | string | null) {
  return useQuery({
    queryKey: [path, 'item', id],
    queryFn: async () => (await http.get<ItemResponse<T>>(`/${path}/${id}`)).data,
    enabled: !!id,
  });
}

/** Create/update/delete with cache invalidation and toast feedback. */
export function useSave<T>(path: string, label: string) {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async ({ id, body }: { id?: number | null; body: unknown }) =>
      id ? (await http.put<ItemResponse<T>>(`/${path}/${id}`, body)).data
         : (await http.post<ItemResponse<T>>(`/${path}`, body)).data,
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: [path] });
      void qc.invalidateQueries({ queryKey: ['lookup'] });
      toast(`${label} ${vars.id ? 'updated' : 'created'} successfully`);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : `Could not save ${label.toLowerCase()}`, 'error'),
  });
}

export function useRemove(path: string, label: string) {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: async (id: number) => await http.del(`/${path}/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [path] });
      void qc.invalidateQueries({ queryKey: ['lookup'] });
      toast(`${label} deleted`);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : `Could not delete ${label.toLowerCase()}`, 'error'),
  });
}

/** Shared list-screen state: paging, search, sorting. */
import { useState } from 'react';
export function useListState(initialSort?: { key: string; dir: 'asc' | 'desc' }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(initialSort ?? { key: 'id', dir: 'desc' as const });

  const onSort = (key: string) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  return {
    page, setPage,
    search,
    setSearch: (v: string) => { setSearch(v); setPage(1); },
    sort, onSort,
  };
}
