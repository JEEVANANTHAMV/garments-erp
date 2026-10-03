import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Ban } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { http } from '../../../lib/api';
import { useToast } from '../../../hooks/useToast';
import { Button, LoadingBlock } from '../../../components/ui';
import { ContractorBillEditor } from '../../../components/ContractorBillEditor';
import { ProcessBillTotalsView, processBillFacts } from '../../../components/ProcessBillParts';
import { fmtDate, fmtDecimal } from '../../../lib/format';
import { FpTitle, FpStatus, errText, kg, n } from './shared';

/**
 * Fabric Process — Contractor bill (doc §27, §33): GRN good KG × rate + approved billable reprocess
 * − recovery from contractor. Non-billable / internal / free reprocess is shown as excluded and can
 * never be billed. Cancelling a bill releases its GRNs / reprocess for billing again.
 */
const money = (v: unknown) => `₹${fmtDecimal(n(v), 2)}`;

export default function FabricProcessBillPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  // keep the other params (Bills Inward tab) when opening / closing a bill
  const setId = (v: string | null) => setParams((p) => { const q = new URLSearchParams(p); if (v) q.set('id', v); else q.delete('id'); return q; });
  if (id === 'new') return <BillEditor onBack={() => setId(null)} onDone={(x) => setId(String(x))} />;
  if (id) return <BillView id={Number(id)} onBack={() => setId(null)} />;
  return <BillList onOpen={(x) => setId(String(x))} />;
}

function BillList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['fabric-process', 'bills'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/bills')).data ?? [] });
  return (
    <div>
      <FpTitle no={6} title="Contractor Bill (Fabric Process)" sub="GRN charges + billable reprocess − recovery" actions={can('FABRIC_PROCESS.BILL') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Bill</Button> : null} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Bill no', 'Date', 'Supplier / Vendor', 'Party bill', 'Lines', 'Gross', 'Recovery', 'GST', 'Net', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/Gross|Recovery|GST|Net|Lines/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(b.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{b.bill_no}</td><td className="px-3 py-2">{fmtDate(b.bill_date)}</td><td className="px-3 py-2">{b.vendor_name}</td>
                  <td className="px-3 py-2">{b.party_bill_no || '—'}</td><td className="px-3 py-2 text-right">{b.line_count}</td><td className="px-3 py-2 text-right">{money(b.gross_amount)}</td>
                  <td className="px-3 py-2 text-right text-red-700">{n(b.recovery_amount) ? `− ${money(b.recovery_amount)}` : '—'}</td><td className="px-3 py-2 text-right">{money(b.gst_amount)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{money(b.net_amount)}</td><td className="px-3 py-2"><FpStatus value={b.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No contractor bills yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function BillEditor({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  return <ContractorBillEditor kind="fabric" title={<FpTitle no={6} title="New Contractor Bill (Fabric Process)" sub="Like the purchase bill: gate entry → GRNs → charges, GST, TDS / TCS" />} onBack={onBack} onDone={onDone} />;
}

function BillView({ id, onBack }: { id: number; onBack: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fabric-process', 'bills', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/bills/${id}`)).data });
  const b = q.data;
  if (!b) return <LoadingBlock />;
  const cancel = async () => {
    const reason = window.prompt(`Cancel ${b.bill_no}? Reason:`);
    if (!reason) return;
    try { const r = await http.post(`/fabric-process/bills/${id}/cancel`, { reason }); toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div>
      <FpTitle no={6} title={`Contractor Bill — ${b.bill_no}`} sub={`${b.vendor_name} · ${fmtDate(b.bill_date)}${b.party_bill_no ? ` · party bill ${b.party_bill_no}` : ''}`}
        actions={<><FpStatus value={b.status} />{b.status === 'POSTED' && can('FABRIC_PROCESS.BILL_CANCEL') && <Button variant="danger" onClick={cancel}><Ban size={14} className="mr-1" /> Cancel bill</Button>}<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 text-xs md:grid-cols-6">{processBillFacts(b).map(([k, v]) => <div key={k}><div className="text-slate-500">{k}</div><div className="font-semibold">{String(v)}</div></div>)}</div>
      <div className="card overflow-x-auto p-2">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Type', 'Doc no', 'Date', 'Our DC', 'Party challan', 'Vehicle', 'Job', 'Process', 'Qty KG', 'Rate', 'Amount'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Rate|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{b.lines.map((l: any) => <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1">{l.line_type}</td><td className="px-2 py-1 font-mono">{l.doc_no}</td><td className="px-2 py-1">{fmtDate(l.doc_date)}</td><td className="px-2 py-1 font-mono">{l.dc_no || '—'}</td><td className="px-2 py-1">{l.challan_no || '—'}</td><td className="px-2 py-1">{l.vehicle_no || '—'}</td><td className="px-2 py-1">{l.io_no || '—'}</td><td className="px-2 py-1">{l.sub_process}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td><td className="px-2 py-1 text-right">{money(l.rate)}</td><td className={`px-2 py-1 text-right ${n(l.amount) < 0 ? 'text-red-700' : ''}`}>{money(l.amount)}</td></tr>)}</tbody>
        </table>
        <div className="mt-2 border-t border-slate-100 pt-2"><ProcessBillTotalsView b={b} /></div>
      </div>
      {b.remarks && <pre className="card mt-3 whitespace-pre-wrap p-3 text-[11px] text-slate-600">{b.remarks}</pre>}
    </div>
  );
}
