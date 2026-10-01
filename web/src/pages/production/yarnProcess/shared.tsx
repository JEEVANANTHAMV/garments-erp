import { useQuery } from '@tanstack/react-query';
import { http } from '../../../lib/api';

/** Yarn Process screens share the Fabric Process building blocks (title, status chip, reconciliation cards, print). */
export { FpTitle as YpTitle, FpStatus as YpStatus, ReconCards, useJobs, useReasons, errText, kg, n, r3, esc, printDoc, groupByJob, type Job } from '../fabricProcess/shared';

export interface YpType {
  id: number; code: string; name: string; base_process: string; process_mode: 'CONE_TO_CONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE'; changes_shade: number;
  default_ply: number | null; ply_options: string | null; loss_tolerance_pct: number; requires_qc: number; allow_reprocess: number; is_reprocess: number;
  billable: number; sort_order: number; is_active: number; qc_params: any[];
}
export const MODE_LABEL: Record<string, string> = { CONE_TO_CONE: 'Cone → cone', ONE_TO_MANY: 'One → many cones', MANY_TO_ONE: 'Many → one cone (ply)' };
export function useYarnTypes() {
  return useQuery({ queryKey: ['yarn-process', 'types'], queryFn: async () => (await http.get<{ data: YpType[] }>('/yarn-process/types')).data ?? [], staleTime: 300_000 });
}
/** Lots a job may send: its own yarn lots + general stock (lot · GRN · PO · supplier · KG). */
export interface YarnLot {
  grn_line_id: number; holder_job: string; holder_so_id: number | null; lot_no: string; yarn_id: number; yarn_name: string; count_str?: string; shade?: string; color_name?: string;
  grn_no: string; po_no?: string; supplier_name?: string; available_kg: number; warehouse_name?: string; cone_no?: string | null; cones?: number; processed?: boolean;
}
