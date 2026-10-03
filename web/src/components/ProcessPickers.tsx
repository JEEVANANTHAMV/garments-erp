import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../lib/api';
import { fmtDate, fmtDecimal } from '../lib/format';

/**
 * Pickers shared by the process DCs and inwards (client voice note 02-Oct-2026):
 *   QuotationPicker — the vendor's ACCEPTED process quotation (and rate line) a DC goes out on;
 *   GateEntryPicker — the security gate entry an inward is mapped to.
 */
export interface QuoteValue { quotation_id: string; quotation_line_id: string; rate_per_kg: string }

export function QuotationPicker({ vendorId, material, process, value, onChange, disabled, idPrefix = 'q', ioNo, soId, label, onQuote }: {
  vendorId: string | number | null | undefined; material: 'FABRIC' | 'YARN' | 'TRIM' | 'GENERAL'; process?: string | null;
  value: QuoteValue; onChange: (v: QuoteValue) => void; disabled?: boolean; idPrefix?: string;
  /** The job the quotation is for: its own (job-wise) quotations come first, other jobs' quotations are not offered. */
  ioNo?: string | null; soId?: number | null; label?: string;
  /** Called with the picked quotation (all its lines, with colour) — a dyeing DC fills the dye colour from it. */
  onQuote?: (q: any | null) => void;
}) {
  const jobQs = `${ioNo ? `&io_no=${encodeURIComponent(ioNo)}` : ''}${soId ? `&so_id=${soId}` : ''}`;
  const q = useQuery({
    queryKey: ['process-quotations', vendorId, material, process, ioNo ?? null, soId ?? null],
    queryFn: async () => http.get<{ data: any[]; required: boolean }>(`/process-quotations?vendor_id=${vendorId}&material=${material}${process ? `&process=${encodeURIComponent(process)}` : ''}${jobQs}`),
    enabled: !!vendorId,
  });
  const list = q.data?.data ?? [];
  const required = !!q.data?.required;
  const quote = list.find((x) => String(x.id) === value.quotation_id);
  useEffect(() => { onQuote?.(quote ?? null); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id, value.quotation_line_id]);
  // pick automatically: the one quotation made for this job, else the only approved quotation
  useEffect(() => {
    if (value.quotation_id) return;
    const own = list.filter((x) => x.job_match);
    const pick = own.length === 1 ? own[0] : list.length === 1 ? list[0] : null;
    if (pick) {
      const l = pick.lines?.[0];
      onChange({ quotation_id: String(pick.id), quotation_line_id: l ? String(l.id) : '', rate_per_kg: l ? String(l.rate) : '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, vendorId, value.quotation_id]);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="label">{label ?? 'Approved process quotation'}{required ? ' *' : ''}</span>
        <select className={`input w-72 py-1.5 text-xs ${required && !value.quotation_id ? 'border-amber-400' : ''}`} disabled={disabled || !vendorId} value={value.quotation_id} id={`${idPrefix}-quotation`}
          onChange={(e) => { const qq = list.find((x) => String(x.id) === e.target.value); const l = qq?.lines?.[0]; onChange({ quotation_id: e.target.value, quotation_line_id: l ? String(l.id) : '', rate_per_kg: l ? String(l.rate) : '' }); }}>
          <option value="">{!vendorId ? '— pick the vendor first —' : list.length ? '— select quotation —' : 'No accepted process quotation for this vendor'}</option>
          {list.map((x) => <option key={x.id} value={x.id}>{x.job_match ? '★ This job · ' : ''}{x.quotation_no}{x.version > 1 ? ` v${x.version}` : ''} · {x.process_name || 'process'} · {fmtDate(x.quotation_date)}{x.valid_until ? ` · valid till ${fmtDate(x.valid_until)}` : ''}</option>)}
        </select>
      </label>
      {quote && (quote.lines?.length ?? 0) > 1 && (
        <label className="block">
          <span className="label">Rate line</span>
          <select className="input w-64 py-1.5 text-xs" disabled={disabled} value={value.quotation_line_id} id={`${idPrefix}-qline`}
            onChange={(e) => { const l = quote.lines.find((x: any) => String(x.id) === e.target.value); onChange({ ...value, quotation_line_id: e.target.value, rate_per_kg: l ? String(l.rate) : value.rate_per_kg }); }}>
            {quote.lines.map((l: any) => <option key={l.id} value={l.id}>{l.job_match ? '★ ' : ''}{l.job_no ? `${l.job_no} · ` : ''}{l.description || l.fabric_name || l.yarn_name || 'Line'}{l.color_name ? ` · ${l.color_name}` : ''} · ₹{fmtDecimal(l.rate, 2)}{l.uom_code ? `/${l.uom_code}` : ''}</option>)}
          </select>
        </label>
      )}
      <div className="pb-1 text-xs">
        {value.quotation_id ? <span className="rounded bg-emerald-50 px-2 py-1 font-semibold text-emerald-800">Rate ₹{fmtDecimal(Number(value.rate_per_kg) || 0, 2)} / KG</span>
          : required ? <span className="text-amber-700">Required — the DC goes out only against an approved process quotation</span> : <span className="text-slate-400">optional</span>}
      </div>
    </div>
  );
}

export function GateEntryPicker({ partyId, value, onChange, onPick, idPrefix = 'gate' }: {
  partyId: string | number | null | undefined; value: string; onChange: (id: string) => void;
  /** Called with the picked gate entry so the screen can fill vehicle / DC no. */
  onPick?: (g: any) => void; idPrefix?: string;
}) {
  const q = useQuery({
    queryKey: ['gate-entries-open', partyId],
    queryFn: async () => http.get<{ data: any[]; required: boolean }>(`/gate-entries/open${partyId ? `?party_id=${partyId}` : ''}`),
  });
  const list = q.data?.data ?? [];
  const required = !!q.data?.required;
  return (
    <label className="block">
      <span className="label">Gate entry{required ? ' *' : ''}</span>
      <select className={`input w-72 py-1.5 text-xs ${required && !value ? 'border-amber-400' : ''}`} value={value} id={`${idPrefix}-entry`}
        onChange={(e) => { onChange(e.target.value); const g = list.find((x) => String(x.id) === e.target.value); if (g && onPick) onPick(g); }}>
        <option value="">{list.length ? (required ? '— map the gate entry —' : '— none —') : 'No gate entry for this party (make it at the gate first)'}</option>
        {list.map((g) => <option key={g.id} value={g.id}>{g.entry_no} · {fmtDate(g.entry_date)} {g.entry_time ?? ''} · {g.vehicle_no}{g.supplier_dc_no ? ` · DC ${g.supplier_dc_no}` : ''}{g.status === 'GRN_COMPLETED' ? ' · (already mapped)' : ''}</option>)}
      </select>
    </label>
  );
}
