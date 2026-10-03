import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';

/**
 * Job (I/O / sales order) picker — client voice note 03-Oct-2026: wherever a screen asks for the internal order,
 * it is picked, never typed, and picking it fills the sales order, style(s) and buyer PO. The value is the job no
 * (I/O no, else SO no); `onPick` hands back the whole job. A value that is not a known job (typed on an old record)
 * still shows, marked.
 */
export interface Job {
  id: number; so_no: string; io_no: string | null; job_no: string; buyer_po_no: string | null; buyer_id: number | null; buyer_name: string | null;
  styles: { style_id: number; style_code: string; style_name: string; order_qty: number; plan_cut_qty: number }[];
  style_ids: number[]; style_codes: string; order_qty: number; plan_cut_qty: number; label: string;
}

export function useJobs() {
  return useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: Job[] }>('/procurement/jobs')).data ?? [], staleTime: 60_000 });
}

/** The job's single style, when it has exactly one (else the caller keeps / asks for the style). */
export const onlyStyle = (j: Job | null | undefined) => (j && j.styles.length === 1 ? j.styles[0].style_id : null);

export function JobSelect({ value, onPick, label = 'Job (I/O no)', required, id, className = '', disabled, by = 'job_no', placeholder = '— Select job —' }: {
  value: string | number | null | undefined; onPick: (job: Job | null) => void; label?: string; required?: boolean; id?: string; className?: string; disabled?: boolean;
  /** what `value` holds: the job no (default) or the sales order id */
  by?: 'job_no' | 'so_id'; placeholder?: string;
}) {
  const jobs = useJobs();
  const list = jobs.data ?? [];
  const key = (j: Job) => (by === 'so_id' ? String(j.id) : j.job_no);
  const v = value == null ? '' : String(value);
  const known = !v || list.some((j) => key(j) === v);
  return (
    <label className={`block ${className}`}>
      {label && <span className="label">{label}{required ? ' *' : ''}</span>}
      <select className="input" value={v} id={id} disabled={disabled}
        onChange={(e) => onPick(list.find((j) => key(j) === e.target.value) ?? null)}>
        <option value="">{jobs.isLoading ? 'Loading jobs…' : placeholder}</option>
        {!known && <option value={v}>{v} (not a job on file)</option>}
        {list.map((j) => <option key={j.id} value={key(j)}>{j.label}{j.buyer_po_no ? ` · PO ${j.buyer_po_no}` : ''}</option>)}
      </select>
    </label>
  );
}
