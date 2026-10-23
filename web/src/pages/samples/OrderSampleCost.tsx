import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, LoadingBlock } from '../../components/ui';
import { http } from '../../lib/api';
import { fmtDate, fmtNumber } from '../../lib/format';
import { ALLOC_STATUS_TONE, inr } from './sampleShared';

/**
 * Sample development cost carried by a sales order (spec §6.8): each allocation line with its sample and batch, so the
 * order's "Sample dev" figure in Budget vs Actuals can be traced back to the sample's cost ledger.
 */
export function OrderSampleCost({ soId }: { soId: number }) {
  const q = useQuery({ queryKey: ['order-sample-cost', soId], queryFn: async () => http.get<{ data: any[]; total_posted: number; total_pending: number; basis: string }>(`/sample-allocations/by-order/${soId}`) });
  if (q.isLoading) return <div className="card"><LoadingBlock rows={3} /></div>;
  const rows = q.data?.data ?? [];
  return (
    <div className="card overflow-hidden" id="order-sample-cost">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
        <div>
          <h3 className="text-[13.5px] font-semibold text-slate-800">Sample development cost in this order</h3>
          <p className="text-[12px] text-slate-500">{q.data?.basis}</p>
        </div>
        <div className="text-right text-[12.5px]">
          <p>In the order P&amp;L: <b className="text-[15px]">{inr(q.data?.total_posted ?? 0, '₹ 0')}</b></p>
          {Number(q.data?.total_pending) > 0 && <p className="text-amber-700">Awaiting approval {inr(q.data?.total_pending)}</p>}
        </div>
      </div>
      {!rows.length ? <p className="py-10 text-center text-[13px] text-slate-400">No sample cost is allocated to this order.</p> : (
        <table className="w-full">
          <thead><tr><th className="th">Sample</th><th className="th">Allocation</th><th className="th text-right">Share</th><th className="th text-right">Amount ₹</th><th className="th">State</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line_id} className={r.line_status === 'REVERSED' ? 'opacity-60' : 'row-hover'}>
                <td className="td"><Link className="font-mono text-[12px] font-semibold text-brand-700 hover:underline" to={`/sales/samples/${r.sample_id}?tab=costing`}>{r.sample_no}</Link>
                  <p className="text-[11px] text-slate-500">{r.sample_type} · {r.style_code} · {fmtNumber(r.sample_qty)} pcs</p></td>
                <td className="td text-[12px]"><Link className="font-mono hover:underline" to={`/sales/samples/${r.sample_id}?tab=allocation`}>{r.batch_no}</Link> · {String(r.method).toLowerCase()}
                  <p className="text-slate-500">{r.posted_at ? `posted ${fmtDate(r.posted_at)}` : ''} {r.reason}</p></td>
                <td className="td text-right text-[12px] tabular-nums">{fmtNumber(r.basis_pct, 2)}%</td>
                <td className="td text-right tabular-nums font-semibold">{fmtNumber(r.allocated_amount, 2)}</td>
                <td className="td">{r.line_status === 'REVERSED' ? <Badge tone="gray">reversed {fmtDate(r.reversed_at)}</Badge> : <Badge tone={ALLOC_STATUS_TONE[r.batch_status] ?? 'slate'}>{String(r.batch_status).replace(/_/g, ' ').toLowerCase()}</Badge>}
                  {r.reverse_reason && <p className="text-[11px] text-slate-500">{r.reverse_reason}</p>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
