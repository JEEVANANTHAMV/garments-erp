/**
 * Visitor pass with photo (client voice notes 04-Nov-2026: visitor photo at the gate). Route /gate/visitors/:id/pass —
 * on screen a preview; Print sends only the pass card (A6) to the printer.
 */
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer, UserRound } from 'lucide-react';
import { PageHeader, LoadingBlock, ErrorState } from '../../components/ui';
import { http } from '../../lib/api';
import { useMyCompany } from '../../lib/myCompany';
import { fmtDate, humanize } from '../../lib/format';

function PassCard({ v, company }: { v: any; company?: string }) {
  const row = (label: string, value: unknown) => (
    <tr><td className="pr-2 align-top text-ink-secondary">{label}</td><td className="font-semibold text-ink">{value == null || value === '' ? '—' : String(value)}</td></tr>
  );
  return (
    <div className="visitor-pass mx-auto w-full max-w-[420px] rounded-lg border-2 border-ink p-3 text-small" data-visitor-pass>
      <div className="mb-2 flex items-center justify-between border-b border-ink pb-1.5">
        <div><p className="text-title font-semibold text-ink">{company ?? 'Visitor Pass'}</p><p className="text-caption uppercase tracking-wider text-ink-secondary">{humanize(v.visitor_type)} pass</p></div>
        <p className="text-title font-semibold tabular-nums text-ink">{v.entry_no}</p>
      </div>
      <div className="flex gap-3">
        <div className="h-32 w-28 shrink-0 overflow-hidden rounded border border-surface-border bg-surface-muted">
          {v.photo_url ? <img src={v.photo_url} alt={v.person_name} className="h-full w-full object-cover" data-pass-photo /> : <div className="grid h-full place-items-center text-ink-muted"><UserRound size={40} /></div>}
        </div>
        <table className="min-w-0 flex-1"><tbody>
          {row('Name', `${v.person_name}${v.person_count > 1 ? ` +${v.person_count - 1}` : ''}`)}
          {row('Company', v.organisation || v.party_name)}
          {row('Phone', v.phone)}
          {row('To meet', [v.whom_to_meet, v.host_department_name].filter(Boolean).join(' · '))}
          {row('Purpose', v.purpose)}
          {row('Date', `${fmtDate(v.visit_date)} · in ${v.in_time ?? '—'}${v.out_time ? ` · out ${v.out_time}` : ''}`)}
          {row('Vehicle', v.vehicle_no)}
          {row('ID proof', v.id_proof)}
        </tbody></table>
      </div>
      <div className="mt-6 flex justify-between text-caption text-ink-secondary">
        <span>Security: {v.security_guard ?? '________'}</span><span>Host signature ________</span>
      </div>
    </div>
  );
}

export function GateVisitorPass() {
  const { id } = useParams();
  const nav = useNavigate();
  const company = useMyCompany();
  const q = useQuery({ queryKey: ['gate-visitors', 'pass', id], queryFn: async () => (await http.get<{ data: any }>(`/gate-visitors/${id}`)).data });
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} />;
  const name = company.data?.trade_name || company.data?.legal_name;
  return (
    <>
      <PageHeader breadcrumb={['Gate Security', 'Visitors']} title={`Visitor pass ${q.data.entry_no ?? ''}`}
        actions={<>
          <button className="btn-secondary" onClick={() => nav('/gate/visitors')}><ArrowLeft size={15} /> Back</button>
          <button className="btn-primary" onClick={() => window.print()} data-action="print"><Printer size={15} /> Print</button>
        </>} />
      <PassCard v={q.data} company={name} />
      {createPortal(
        <div id="visitor-pass-print">
          <style>{`
            #visitor-pass-print { display: none; }
            @media print {
              @page { size: A6 landscape; margin: 4mm; }
              body > *:not(#visitor-pass-print) { display: none !important; }
              #visitor-pass-print { display: block !important; }
              #visitor-pass-print .visitor-pass { max-width: none; }
            }
          `}</style>
          <PassCard v={q.data} company={name} />
        </div>,
        document.body,
      )}
    </>
  );
}
