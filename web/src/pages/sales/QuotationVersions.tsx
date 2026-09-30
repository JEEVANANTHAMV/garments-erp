import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { http } from '../../lib/api';
import { Modal, Spinner } from '../../components/ui';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * Quotation versions: every save that changes a saved quotation keeps the previous content
 * as V1, V2 … (server: trx_quotation_version). Lists the versions and shows an earlier one
 * read-only, highlighting the cells that differ from the current quotation.
 */
interface VersionRow { version: number; total_amount: number; replaced_at: string | null; replaced_by: string | null; saved_at?: string; saved_by?: string; line_count?: number; current: boolean }

const COLS: { key: string; label: string; num?: boolean }[] = [
  { key: 'job_no', label: 'I/O' },
  { key: 'description', label: 'Description' },
  { key: 'qty', label: 'Qty', num: true },
  { key: 'quotation_rate', label: 'Quotation rate', num: true },
  { key: 'confirm_rate', label: 'Confirm rate', num: true },
  { key: 'gst_rate', label: 'GST %', num: true },
  { key: 'amount', label: 'Amount', num: true },
];
const same = (a: unknown, b: unknown, num?: boolean) => (num ? Number(a || 0) === Number(b || 0) : String(a ?? '') === String(b ?? ''));

export function QuotationVersionsButton({ quotationId, currentLines }: { quotationId: number; currentLines: any[] }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ['quotations', 'versions', quotationId],
    queryFn: async () => (await http.get<{ data: { quotation_no: string; current_version: number; versions: VersionRow[] } }>(`/quotations/${quotationId}/versions`)).data,
    enabled: !!quotationId,
  });
  const snap = useQuery({
    queryKey: ['quotations', 'versions', quotationId, view],
    queryFn: async () => (await http.get<{ data: { version: number; replaced_at: string; header: any; lines: any[] } }>(`/quotations/${quotationId}/versions/${view}`)).data,
    enabled: !!quotationId && view !== null,
  });
  const cur = list.data?.current_version ?? 1;
  const count = list.data?.versions.length ?? 1;

  return (
    <>
      <button className="btn-secondary" onClick={() => { setOpen(true); setView(null); }} title="Earlier versions of this quotation">
        <History size={15} /> V{cur}{count > 1 ? ` · ${count} versions` : ''}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl" title={`Versions — ${list.data?.quotation_no ?? ''}`}>
        {list.isLoading ? <Spinner /> : (
          <div className="space-y-4">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr><th className="px-2 py-2 text-left">Version</th><th className="px-2 py-2 text-left">Saved</th><th className="px-2 py-2 text-right">Total</th><th className="px-2 py-2 text-left">Replaced</th><th /></tr>
              </thead>
              <tbody>
                {(list.data?.versions ?? []).map((v) => (
                  <tr key={v.version} className={`border-t border-slate-100 ${view === v.version ? 'bg-brand-50' : ''}`}>
                    <td className="px-2 py-1.5 font-mono font-bold">V{v.version}{v.current && <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">current</span>}</td>
                    <td className="px-2 py-1.5">{v.current ? `${fmtDate(v.saved_at)}${v.saved_by ? ` · ${v.saved_by}` : ''}` : '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(v.total_amount, 2)}</td>
                    <td className="px-2 py-1.5">{v.current ? '—' : `${fmtDate(v.replaced_at)}${v.replaced_by ? ` by ${v.replaced_by}` : ''}`}</td>
                    <td className="px-2 py-1.5 text-right">
                      {!v.current && <button className="btn-secondary btn-sm" onClick={() => setView(v.version)}>View V{v.version}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {count === 1 && <p className="text-[11.5px] text-slate-500">No earlier versions yet — each saved change to this quotation keeps the previous one as V{cur}.</p>}
            {view !== null && (
              snap.isLoading ? <Spinner /> : snap.data && (
                <div>
                  <h4 className="mb-1 text-[12.5px] font-semibold text-slate-800">
                    V{view} <span className="font-normal text-slate-500">(replaced {fmtDate(snap.data.replaced_at)}) · total {fmtDecimal(snap.data.header?.total_amount, 2)} · cells changed since are highlighted</span>
                  </h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr><th className="px-2 py-1.5 text-left">#</th>{COLS.map((c) => <th key={c.key} className={`px-2 py-1.5 ${c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr>
                      </thead>
                      <tbody>
                        {snap.data.lines.map((l, i) => {
                          const now = currentLines[i];
                          return (
                            <tr key={i} className="border-t border-slate-100">
                              <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                              {COLS.map((c) => {
                                const changed = !now || !same(l[c.key], now[c.key], c.num);
                                return (
                                  <td key={c.key} className={`px-2 py-1 ${c.num ? 'text-right tabular-nums' : ''} ${changed ? 'bg-amber-100 font-semibold text-amber-900' : ''}`}
                                    title={changed && now ? `now: ${now[c.key] ?? '—'}` : undefined}>
                                    {c.num ? fmtDecimal(l[c.key], c.key === 'qty' ? 3 : 2) : (l[c.key] || '—')}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {currentLines.length !== snap.data.lines.length && (
                    <p className="mt-1 text-[11px] text-slate-500">V{view} had {snap.data.lines.length} line(s); the current version has {currentLines.length}.</p>
                  )}
                </div>
              )
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
