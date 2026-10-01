import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, Ban, Download, Pencil, CheckCircle2 } from 'lucide-react';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Input, Select, Tabs, LoadingBlock, Modal, Checkbox } from '../../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../../lib/format';
import { YpTitle, YpStatus, ReconCards, useYarnTypes, errText, kg, n, MODE_LABEL, type YpType } from './shared';

/** Yarn Process — contractor bill (doc §14), cone tracking (§15), ledger / job reconciliation / reports (§16, §24), process types (§26). */

// ======================================================================= Contractor bill
export function YarnProcessBillPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <BillEditor onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <BillView id={Number(id)} onBack={() => setParams({})} />;
  return <BillList onOpen={(x) => setParams({ id: String(x) })} />;
}
function BillList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['yarn-process', 'bills'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/bills')).data ?? [] });
  return (
    <div>
      <YpTitle no={6} title="Yarn Process Contractor Bill" sub="GRN charges + billable reprocess − recovery · non-billable excluded"
        actions={can('YARN_PROCESS.BILL') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Bill</Button> : null} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Bill no', 'Date', 'Contractor', 'Party bill', 'Lines', 'Gross', 'Recovery', 'GST', 'Net', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/Gross|Recovery|GST|Net|Lines/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(b.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{b.bill_no}</td><td className="px-3 py-2">{fmtDate(b.bill_date)}</td><td className="px-3 py-2">{b.vendor_name}</td><td className="px-3 py-2">{b.party_bill_no || '—'}</td>
                  <td className="px-3 py-2 text-right">{b.line_count}</td><td className="px-3 py-2 text-right">₹{fmtDecimal(b.gross_amount, 2)}</td><td className="px-3 py-2 text-right text-red-700">₹{fmtDecimal(b.recovery_amount, 2)}</td>
                  <td className="px-3 py-2 text-right">₹{fmtDecimal(b.gst_amount, 2)}</td><td className="px-3 py-2 text-right font-semibold">₹{fmtDecimal(b.net_amount, 2)}</td><td className="px-3 py-2"><YpStatus value={b.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No bills yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
function BillEditor({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useLookup('suppliers');
  const types = useYarnTypes();
  const [h, setH] = useState({ vendor_id: '', bill_date: today(), party_bill_no: '', from_date: '', to_date: '', process_code: '', io_no: '', billing_type: '', gst_pct: '5', discount_amount: '', other_charges: '', remarks: '' });
  const [src, setSrc] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!h.vendor_id) { toast('Choose the contractor', 'warning'); return; }
    const p = new URLSearchParams({ vendor_id: h.vendor_id }); (['from_date', 'to_date'] as const).forEach((k) => h[k] && p.set(k === 'from_date' ? 'from' : 'to', h[k]));
    if (h.process_code) p.set('process_code', h.process_code); if (h.io_no) p.set('io_no', h.io_no); if (h.billing_type) p.set('billing_type', h.billing_type);
    try { const r = (await http.get<{ data: any }>(`/yarn-process/bill-sources?${p}`)).data; setSrc(r); setSel(Object.fromEntries([...r.grns.map((g: any) => [`GRN-${g.ref_id}`, n(g.last_rate)]), ...r.reprocess.map((x: any) => [`${x.line_type}-${x.ref_id}`, n(x.rate)])])); } catch (e) { toast(errText(e), 'error'); }
  };
  const rows = src ? [...src.grns.map((g: any) => ({ ...g, k: `GRN-${g.ref_id}` })), ...src.reprocess.map((x: any) => ({ ...x, k: `${x.line_type}-${x.ref_id}` }))] : [];
  const amt = (r: any) => (r.line_type === 'GRN' ? n(r.qty_kg) * n(sel[r.k]) : n(r.bill_amount) * (r.line_type === 'RECOVERY' ? -1 : 1));
  const picked = rows.filter((r) => sel[r.k] !== undefined);
  const gross = picked.filter((r) => r.line_type !== 'RECOVERY').reduce((a, r) => a + amt(r), 0), rec = -picked.filter((r) => r.line_type === 'RECOVERY').reduce((a, r) => a + amt(r), 0);
  const taxable = gross - rec - n(h.discount_amount) + n(h.other_charges), net = taxable * (1 + n(h.gst_pct) / 100);
  const save = async () => {
    if (!picked.length) { toast('Pick the GRNs / reprocess to bill', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/yarn-process/bills', { vendor_id: Number(h.vendor_id), bill_date: h.bill_date, party_bill_no: h.party_bill_no || null, from_date: h.from_date || null, to_date: h.to_date || null,
        gst_pct: n(h.gst_pct), discount_amount: n(h.discount_amount), other_charges: n(h.other_charges), remarks: h.remarks || null, lines: picked.map((r) => ({ line_type: r.line_type, ref_id: r.ref_id, rate: n(sel[r.k]) })) });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <YpTitle no={6} title="New Yarn Process Contractor Bill" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Select label="Contractor *" value={h.vendor_id} placeholder="— Process unit —" onChange={(e) => { setH({ ...h, vendor_id: e.target.value }); setSrc(null); }} options={toOptions(suppliers.data)} />
        <Input label="Bill date *" type="date" value={h.bill_date} onChange={(e) => setH({ ...h, bill_date: e.target.value })} />
        <Input label="Party bill no" value={h.party_bill_no} onChange={(e) => setH({ ...h, party_bill_no: e.target.value })} />
        <Input label="From" type="date" value={h.from_date} onChange={(e) => setH({ ...h, from_date: e.target.value })} />
        <Input label="To" type="date" value={h.to_date} onChange={(e) => setH({ ...h, to_date: e.target.value })} />
        <Select label="Process" value={h.process_code} placeholder="All" onChange={(e) => setH({ ...h, process_code: e.target.value })} options={(types.data ?? []).map((t) => ({ value: t.code, label: t.name }))} />
        <Input label="Job" value={h.io_no} placeholder="IO no" onChange={(e) => setH({ ...h, io_no: e.target.value })} />
        <Select label="Billing type" value={h.billing_type} placeholder="All" onChange={(e) => setH({ ...h, billing_type: e.target.value })} options={[{ value: 'BILLABLE', label: 'Billable only' }, { value: 'RECOVERY', label: 'Recovery only' }]} />
        <div className="flex items-end"><Button onClick={load}><Search size={14} className="mr-1" /> Load GRNs / reprocess</Button></div>
      </div>
      {src && (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Type', 'Doc', 'Date', 'Process', 'Jobs', 'KG', 'Billing', 'Rate / KG', 'Amount'].map((h2, i) => <th key={i} className={`px-2 py-2 ${/KG|Rate|Amount/.test(h2) ? 'text-right' : 'text-left'}`}>{h2}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const on = sel[r.k] !== undefined;
                  return (
                    <tr key={r.k} className={`border-t border-slate-100 ${on ? 'bg-emerald-50' : ''}`}>
                      <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const x = { ...s }; if (on) delete x[r.k]; else x[r.k] = n(r.last_rate ?? r.rate); return x; })} /></td>
                      <td className="px-2 py-1">{r.line_type}</td><td className="px-2 py-1 font-mono">{r.doc_no}</td><td className="px-2 py-1">{fmtDate(r.doc_date)}</td><td className="px-2 py-1">{r.process_name || r.process_code}</td>
                      <td className="px-2 py-1">{r.io_no || '—'}</td><td className="px-2 py-1 text-right">{kg(r.qty_kg)}</td><td className="px-2 py-1">{r.line_type === 'GRN' ? 'Process charge' : `${r.billing_type} · ${r.cost_treatment}`}</td>
                      <td className="px-2 py-1 text-right">{r.line_type === 'GRN' && on ? <input type="number" step="0.01" className="input w-20 py-0.5 text-right text-xs" value={sel[r.k]} onChange={(e) => setSel((s) => ({ ...s, [r.k]: Number(e.target.value) }))} /> : fmtDecimal(n(r.rate ?? r.last_rate), 2)}</td>
                      <td className={`px-2 py-1 text-right ${amt(r) < 0 ? 'text-red-700' : ''}`}>₹{fmtDecimal(amt(r), 2)}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Nothing to bill for this contractor</td></tr>}
              </tbody>
            </table>
          </div>
          {(src.excluded.length > 0 || src.pending_approval.length > 0) && (
            <div className="mt-2 text-[11.5px] text-slate-600">
              {src.excluded.length > 0 && <div>Excluded (non-billable): {src.excluded.map((x: any) => `${x.doc_no} (${kg(x.qty_kg)} KG, ${x.cost_treatment.toLowerCase()})`).join(', ')}</div>}
              {src.pending_approval.length > 0 && <div className="text-amber-700">Waiting for billing approval: {src.pending_approval.map((x: any) => x.doc_no).join(', ')}</div>}
            </div>
          )}
          <div className="card mt-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
            <Input label="Discount (₹)" type="number" value={h.discount_amount} onChange={(e) => setH({ ...h, discount_amount: e.target.value })} />
            <Input label="Other charges (₹)" type="number" value={h.other_charges} onChange={(e) => setH({ ...h, other_charges: e.target.value })} />
            <Input label="GST %" type="number" value={h.gst_pct} onChange={(e) => setH({ ...h, gst_pct: e.target.value })} />
            <div className="text-xs"><div className="text-slate-500">Gross / recovery</div><div className="font-semibold">₹{fmtDecimal(gross, 2)} / <span className="text-red-700">₹{fmtDecimal(rec, 2)}</span></div></div>
            <div className="text-xs"><div className="text-slate-500">Taxable</div><div className="font-semibold">₹{fmtDecimal(taxable, 2)}</div></div>
            <div className="text-xs"><div className="text-slate-500">Net</div><div className="text-lg font-bold">₹{fmtDecimal(net, 2)}</div></div>
          </div>
          <div className="mt-3 flex justify-end"><Button loading={busy} onClick={save}><CheckCircle2 size={14} className="mr-1" /> Post Bill</Button></div>
        </>
      )}
    </div>
  );
}
function BillView({ id, onBack }: { id: number; onBack: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['yarn-process', 'bills', id], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/bills/${id}`)).data });
  const b = q.data;
  if (!b) return <LoadingBlock />;
  const cancel = async () => {
    const reason = window.prompt(`Cancel ${b.bill_no}? Reason:`); if (!reason || reason.trim().length < 3) return;
    try { const r = await http.post<{ message: string }>(`/yarn-process/bills/${id}/cancel`, { reason }); toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div>
      <YpTitle no={6} title={`Yarn Contractor Bill — ${b.bill_no}`} sub={`${b.vendor_name} · ${fmtDate(b.bill_date)}${b.party_bill_no ? ` · party bill ${b.party_bill_no}` : ''}`}
        actions={<><YpStatus value={b.status} />{b.status === 'POSTED' && can('YARN_PROCESS.BILL_CANCEL') && <Button variant="danger" onClick={cancel}><Ban size={14} className="mr-1" /> Cancel bill</Button>}<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Type', 'Doc', 'Date', 'Process', 'Jobs', 'KG', 'Rate', 'Amount'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Rate|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{b.lines.map((l: any) => <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1">{l.line_type}</td><td className="px-2 py-1 font-mono">{l.doc_no}</td><td className="px-2 py-1">{fmtDate(l.doc_date)}</td><td className="px-2 py-1">{l.process_code}</td>
            <td className="px-2 py-1">{l.io_no || '—'}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td><td className="px-2 py-1 text-right">{fmtDecimal(l.rate, 2)}</td><td className={`px-2 py-1 text-right ${n(l.amount) < 0 ? 'text-red-700' : ''}`}>₹{fmtDecimal(l.amount, 2)}</td></tr>)}</tbody>
          <tfoot className="bg-slate-100 font-semibold">
            {[['Gross', b.gross_amount], ['Recovery', -n(b.recovery_amount)], ['Discount', -n(b.discount_amount)], ['Other charges', b.other_charges], [`GST ${b.gst_pct}%`, b.gst_amount], ['Net', b.net_amount]].map(([k, v]) => (
              <tr key={String(k)}><td colSpan={7} className="px-2 py-1 text-right">{k}</td><td className="px-2 py-1 text-right">₹{fmtDecimal(Number(v), 2)}</td></tr>))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ======================================================================= Cone tracking
const EVENT_LABEL: Record<string, string> = {
  YARN_RECEIPT: 'Yarn receipt', PROCESS_OUTWARD: 'Process outward', PROCESS_INWARD: 'Process inward', REJECT: 'Reject', PROCESS_LOSS: 'Process loss', RETURN: 'Return',
  REPROCESS_OUTWARD: 'Reprocess outward', REPROCESS_INWARD: 'Reprocess inward', DC_CANCELLED: 'DC cancelled', SHORT_CLOSED: 'DC closed (short)', REJECTED_WRITE_OFF: 'Rejected / written off',
  KNITTING_ISSUE: 'Knitting issue', ISSUE: 'Issue', JOB_TRANSFER: 'Job transfer',
};
export function YarnConeTrackingPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const key = params.get('q');
  const h = useQuery({ queryKey: ['yarn-process', 'cone-history', key], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/cone-history?q=${encodeURIComponent(key!)}`)).data, enabled: !!key, retry: false });
  const d = h.data;
  return (
    <div>
      <YpTitle no={7} title="Cone / Lot Tracking" sub="Yarn receipt → process outward → unit → GRN (output cones) → winding / twisting → knitting" />
      <div className="card mb-3 flex flex-wrap items-end gap-2 p-4">
        <Input label="Lot no / cone no" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) setParams({ q: q.trim() }); }} />
        <Button onClick={() => q.trim() && setParams({ q: q.trim() })}><Search size={14} className="mr-1" /> Track</Button>
      </div>
      {key && h.isLoading && <LoadingBlock />}
      {h.error && <div className="card p-6 text-sm text-red-700">{errText(h.error)}</div>}
      {d && (
        <>
          <div className="card mb-3 overflow-x-auto">
            <h3 className="px-4 pt-3 text-[13px] font-semibold text-slate-800">Lots / cones in this chain ({d.lots.length})</h3>
            <table className="mt-2 w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Lot', 'Cone', 'Yarn', 'Type', 'Shade', 'Job', 'GRN', 'Store', 'Status', 'In KG', 'Balance KG'].map((x) => <th key={x} className={`px-2 py-1.5 ${/KG/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>{d.lots.map((l: any) => (
                <tr key={l.grn_line_id} className={`border-t border-slate-100 ${String(l.lot_no) === key || String(l.cone_no) === key ? 'bg-amber-50 font-semibold' : ''}`}>
                  <td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.cone_no || '—'}</td><td className="px-2 py-1">{l.yarn_name}</td><td className="px-2 py-1">{l.yarn_type || (l.source_ypo_id ? 'Processed' : 'Purchased')}</td>
                  <td className="px-2 py-1">{l.shade || '—'}</td><td className="px-2 py-1">{l.io_no || 'General'}</td><td className="px-2 py-1 font-mono">{l.grn_no}</td><td className="px-2 py-1">{l.warehouse_name}</td>
                  <td className="px-2 py-1"><YpStatus value={l.qc_status} /></td><td className="px-2 py-1 text-right">{kg(l.accepted_qty)}</td><td className="px-2 py-1 text-right">{kg(l.balance_kg)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <h3 className="px-4 pt-3 text-[13px] font-semibold text-slate-800">Cone history</h3>
            <table className="mt-2 w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['When', 'Event', 'Reference', 'Lot / cone', 'Process', 'From', 'To', 'Qty KG', 'Job', 'Remarks', 'User'].map((x) => <th key={x} className={`px-2 py-1.5 ${/KG/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>{d.timeline.map((e: any, i: number) => (
                <tr key={i} className="border-t border-slate-100"><td className="px-2 py-1">{fmtDate(e.when)}</td><td className="px-2 py-1 font-semibold">{EVENT_LABEL[e.event] ?? e.event}</td><td className="px-2 py-1 font-mono">{e.ref_no}</td>
                  <td className="px-2 py-1 font-mono">{e.lot_no}{e.cone_no ? ` / ${e.cone_no}` : ''}</td><td className="px-2 py-1">{e.process || '—'}</td><td className="px-2 py-1">{e.from || '—'}</td><td className="px-2 py-1">{e.to || '—'}</td>
                  <td className="px-2 py-1 text-right">{kg(e.qty_kg)}</td><td className="px-2 py-1">{e.io_no || '—'}</td><td className="px-2 py-1">{e.remarks || ''}</td><td className="px-2 py-1">{e.user || ''}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ======================================================================= Ledger / job reconciliation / reports
const REPORTS: { key: string; label: string; cols: [string, string, ('kg' | 'amt' | 'date' | 'pct' | 'status')?][] }[] = [
  { key: 'job-status', label: 'Job-wise reconciliation', cols: [['io_no', 'Job'], ['buyer_po_no', 'PO'], ['style_code', 'Style'], ['process_name', 'Process'], ['dcs', 'DCs'], ['outward_kg', 'Outward', 'kg'], ['good_kg', 'Good', 'kg'], ['reject_kg', 'Reject', 'kg'], ['loss_kg', 'Loss', 'kg'], ['balance_kg', 'Balance', 'kg'], ['status', 'Status', 'status']] },
  { key: 'ledger', label: 'Process ledger', cols: [['doc_date', 'Date', 'date'], ['doc_no', 'Doc'], ['txn', 'Txn'], ['process_code', 'Process'], ['contractor', 'Process unit'], ['jobs', 'Jobs'], ['outward_kg', 'Outward', 'kg'], ['good_kg', 'Good', 'kg'], ['reject_kg', 'Reject', 'kg'], ['loss_kg', 'Loss', 'kg'], ['balance_kg', 'Running balance', 'kg']] },
  { key: 'unit-pending', label: 'Pending at process unit', cols: [['vendor', 'Process unit'], ['process_code', 'Process'], ['open_dcs', 'Open DCs'], ['dcs', 'DC nos'], ['oldest_dc_date', 'Oldest DC', 'date'], ['oldest_days', 'Days'], ['outward_kg', 'Outward', 'kg'], ['received_kg', 'Received', 'kg'], ['pending_kg', 'Pending', 'kg']] },
  { key: 'reject-return', label: 'Reject / return', cols: [['kind', 'Type'], ['doc_date', 'Date', 'date'], ['doc_no', 'Doc'], ['ypo_no', 'DC'], ['vendor', 'Process unit'], ['process_code', 'Process'], ['io_no', 'Job'], ['lot_no', 'Lot'], ['cone_no', 'Cone'], ['qty_kg', 'KG', 'kg'], ['reason', 'Reason']] },
  { key: 'reprocess-pending', label: 'Reprocess pending', cols: [['reprocess_no', 'Reprocess'], ['reprocess_date', 'Date', 'date'], ['days', 'Days'], ['process_code', 'Process'], ['vendor', 'Process unit'], ['ypo_no', 'DC'], ['status', 'Status', 'status'], ['total_kg', 'KG', 'kg'], ['pending_kg', 'Not received', 'kg'], ['billing_type', 'Billing'], ['cost_treatment', 'Treatment'], ['billing_status', 'Billing status', 'status'], ['bill_amount', 'Amount', 'amt'], ['pending_for', 'Pending for']] },
  { key: 'billing', label: 'Billable / non-billable', cols: [['reason', 'Reason'], ['billing_type', 'Billing'], ['cost_treatment', 'Treatment'], ['vendor', 'Process unit'], ['entries', 'Entries'], ['kg', 'KG', 'kg'], ['bill_amount', 'Bill / recovery amount', 'amt'], ['internal_cost', 'Internal cost', 'amt']] },
  { key: 'process-loss', label: 'Process loss', cols: [['inward_no', 'GRN'], ['inward_date', 'Date', 'date'], ['ypo_no', 'DC'], ['process_code', 'Process'], ['vendor', 'Process unit'], ['io_no', 'Job'], ['input_kg', 'Input', 'kg'], ['good_kg', 'Good', 'kg'], ['reject_kg', 'Reject', 'kg'], ['loss_kg', 'Loss', 'kg'], ['loss_pct', 'Loss %', 'pct'], ['yield_pct', 'Yield %', 'pct']] },
  { key: 'input-output', label: 'Winding / twisting input vs output', cols: [['inward_no', 'GRN'], ['inward_date', 'Date', 'date'], ['process_code', 'Process'], ['process_mode', 'Mode'], ['io_no', 'Job'], ['input_cones', 'Input cones'], ['output_cones', 'Output cones'], ['input_kg', 'Input', 'kg'], ['good_kg', 'Output', 'kg'], ['loss_kg', 'Loss', 'kg'], ['yield_pct', 'Yield %', 'pct']] },
  { key: 'lot-consumption', label: 'Lot-wise consumption', cols: [['lot_no', 'Lot'], ['yarn_name', 'Yarn'], ['grn_no', 'GRN'], ['io_no', 'Job'], ['process_code', 'Process'], ['dcs', 'DCs'], ['issued_kg', 'Issued', 'kg'], ['good_kg', 'Good', 'kg'], ['reject_kg', 'Reject', 'kg'], ['loss_kg', 'Loss', 'kg']] },
  { key: 'unit-performance', label: 'Process unit performance', cols: [['vendor', 'Process unit'], ['process_code', 'Process'], ['grns', 'GRNs'], ['input_kg', 'Input', 'kg'], ['good_kg', 'Good', 'kg'], ['yield_pct', 'Yield %', 'pct'], ['reject_pct', 'Reject %', 'pct'], ['loss_pct', 'Loss %', 'pct'], ['avg_days', 'Avg days at unit']] },
];
export function YarnProcessReportsPage() {
  const [tab, setTab] = useState(REPORTS[0].key);
  const [f, setF] = useState({ from: '', to: '', vendor_id: '', process_code: '' });
  const [applied, setApplied] = useState(f);
  const suppliers = useLookup('suppliers');
  const types = useYarnTypes();
  const rep = REPORTS.find((r) => r.key === tab)!;
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v) as [string, string][]).toString();
  const url = tab === 'job-status' || tab === 'ledger' ? `/yarn-process/${tab}` : `/yarn-process/reports/${tab}`;
  const q = useQuery({ queryKey: ['yarn-process', 'report', tab, qs], queryFn: async () => (await http.get<{ data: any[] }>(`${url}${qs ? `?${qs}` : ''}`)).data ?? [] });
  const sum = useQuery({ queryKey: ['yarn-process', 'summary', qs], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/summary${qs ? `?${qs}` : ''}`)).data });
  const rows = q.data ?? [];
  const fmt = (v: any, t?: string) => (t === 'kg' ? kg(v) : t === 'amt' ? `₹${fmtDecimal(Number(v ?? 0), 2)}` : t === 'date' ? fmtDate(v) : t === 'pct' ? `${fmtDecimal(Number(v ?? 0), 2)}%` : v ?? '—');
  const total = (k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const csv = () => {
    const lines = [rep.cols.map((c) => c[1]).join(','), ...rows.map((r) => rep.cols.map((c) => `"${String(c[2] === 'date' ? fmtDate(r[c[0]]) : r[c[0]] ?? '').replace(/"/g, '""')}"`).join(','))];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `yarn-${tab}.csv`; a.click();
  };
  const s = sum.data;
  return (
    <div>
      <YpTitle no={8} title="Yarn Process Ledger & Reports" sub="Outward / inward / reject / loss / pending · job reconciliation · reprocess billing" />
      {s && (
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
          {[['Yarn outward', `${kg(s.outward_kg)} KG`], ['Yarn inward (good)', `${kg(s.inward_kg)} KG`], ['Reject', `${kg(s.reject_kg)} KG`], ['Process loss', `${kg(s.loss_kg)} KG`], ['Pending at units', `${kg(s.pending_kg)} KG`], ['Reprocess', `${kg(s.reprocess_kg)} KG`],
            ['Billable reprocess', `${kg(s.billable_reprocess_kg)} KG · ₹${fmtDecimal(s.billable_reprocess_amount, 2)}`], ['Non-billable reprocess', `${kg(s.non_billable_reprocess_kg)} KG`], ['Contractor bill pending', `${s.bill_pending_grns} GRN · ${kg(s.bill_pending_kg)} KG`]].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-slate-200 bg-white px-3 py-2"><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="text-[13px] font-bold">{v}</div></div>))}
        </div>
      )}
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={REPORTS.map((r) => ({ key: r.key, label: r.label }))} active={tab} onChange={setTab} /></div>
      <div className="card mb-3 flex flex-wrap items-end gap-2 p-4">
        <Input label="From" type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Process unit" className="w-64" value={f.vendor_id} placeholder="All" onChange={(e) => setF({ ...f, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Select label="Process" className="w-48" value={f.process_code} placeholder="All" onChange={(e) => setF({ ...f, process_code: e.target.value })} options={(types.data ?? []).map((t) => ({ value: t.code, label: t.name }))} />
        <Button onClick={() => setApplied(f)}><Search size={14} className="mr-1" /> Show</Button>
        <Button variant="secondary" disabled={!rows.length} onClick={csv}><Download size={14} className="mr-1" /> Excel (CSV)</Button>
      </div>
      {tab === 'job-status' && rows.length > 0 && <div className="card mb-3 p-4"><ReconCards t={{ outward_kg: total('outward_kg'), good_kg: total('good_kg'), reject_kg: total('reject_kg'), loss_kg: total('loss_kg'), balance_kg: total('balance_kg') }} /></div>}
      <div className="card overflow-x-auto">
        {q.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{rep.cols.map((c) => <th key={c[0]} className={`px-3 py-2 ${c[2] && c[2] !== 'date' && c[2] !== 'status' ? 'text-right' : 'text-left'}`}>{c[1]}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{rep.cols.map((c) => <td key={c[0]} className={`px-3 py-1.5 ${c[2] && c[2] !== 'date' && c[2] !== 'status' ? 'text-right tabular-nums' : ''}`}>{c[2] === 'status' ? <YpStatus value={r[c[0]]} /> : fmt(r[c[0]], c[2])}</td>)}</tr>)}
              {!rows.length && <tr><td colSpan={rep.cols.length} className="px-3 py-10 text-center text-slate-400">Nothing to show</td></tr>}
            </tbody>
            {rows.length > 0 && tab !== 'ledger' && rep.cols.some((c) => c[2] === 'kg' || c[2] === 'amt') && (
              <tfoot className="bg-slate-100 font-bold"><tr>{rep.cols.map((c, i) => <td key={c[0]} className={`px-3 py-2 ${c[2] === 'kg' || c[2] === 'amt' ? 'text-right' : ''}`}>{c[2] === 'kg' || c[2] === 'amt' ? fmt(total(c[0]), c[2]) : i === 0 ? 'Total' : ''}</td>)}</tr></tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}

// ======================================================================= Process types (configurable engine)
export function YarnProcessTypesPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const master = can('YARN_PROCESS.MASTER');
  const types = useYarnTypes();
  const [t, setT] = useState<any>(null);
  const [p, setP] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const yes = (v: unknown) => !!Number(v);
  const saveType = async () => {
    setBusy(true);
    try {
      const body = { ...t, default_ply: t.default_ply === '' ? null : Number(t.default_ply), loss_tolerance_pct: Number(t.loss_tolerance_pct) || 0, sort_order: Number(t.sort_order) || 0 };
      const r = t.id ? await http.put(`/yarn-process/types/${t.id}`, body) : await http.post('/yarn-process/types', body);
      toast((r as any).message, 'success'); setT(null); void qc.invalidateQueries({ queryKey: ['yarn-process', 'types'] });
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const saveParam = async () => {
    setBusy(true);
    const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    try {
      const body = { ...p, min_value: num(p.min_value), max_value: num(p.max_value), target_value: num(p.target_value), sort_order: Number(p.sort_order) || 0 };
      const r = p.id ? await http.put(`/fabric-process/qc-params/${p.id}`, body) : await http.post('/fabric-process/qc-params', body);
      toast((r as any).message, 'success'); setP(null); void qc.invalidateQueries({ queryKey: ['yarn-process', 'types'] });
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const edit = (x: YpType) => setT({ ...x, changes_shade: yes(x.changes_shade), requires_qc: yes(x.requires_qc), allow_reprocess: yes(x.allow_reprocess), is_reprocess: yes(x.is_reprocess), billable: yes(x.billable), is_active: yes(x.is_active), default_ply: x.default_ply ?? '', ply_options: x.ply_options ?? '' });
  return (
    <div>
      <YpTitle no={9} title="Yarn Process Types" sub="Process mode (cone→cone / one→many / many→one), ply rules, loss tolerance, QC and billing per process"
        actions={master ? <Button onClick={() => setT({ code: '', name: '', base_process: 'YARN_DYEING', process_mode: 'CONE_TO_CONE', changes_shade: false, default_ply: '', ply_options: '', loss_tolerance_pct: 0, requires_qc: false, allow_reprocess: true, is_reprocess: false, billable: true, sort_order: 0, is_active: true })}><Plus size={14} className="mr-1" /> New process type</Button> : null} />
      {types.isLoading ? <LoadingBlock /> : (
        <div className="space-y-3">
          {(types.data ?? []).map((x) => (
            <div key={x.id} className={`card overflow-hidden ${yes(x.is_active) ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2.5 text-xs">
                <span className="font-mono font-bold text-brand-700">{x.code}</span><span className="text-[13px] font-semibold">{x.name}</span>
                <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10.5px] font-bold text-sky-800">{MODE_LABEL[x.process_mode]}</span>
                {x.default_ply ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-bold">{x.default_ply}-ply{x.ply_options ? ` (${x.ply_options})` : ''}</span> : null}
                {n(x.loss_tolerance_pct) > 0 && <span className="text-slate-600">loss ≤ {x.loss_tolerance_pct}%</span>}
                {yes(x.requires_qc) && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10.5px] font-bold text-orange-800">QC before posting</span>}
                {yes(x.is_reprocess) && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10.5px] font-bold text-purple-800">Reprocess</span>}
                {!yes(x.billable) && <span className="text-slate-500">not billable</span>}
                {master && <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => edit(x)}><Pencil size={12} className="mr-1" /> Edit</Button>
                  <Button size="sm" onClick={() => setP({ process_code: x.code, param_name: '', uom: '', min_value: '', max_value: '', target_value: '', is_mandatory: true, sort_order: ((x.qc_params?.length ?? 0) + 1) * 10, is_active: true })}><Plus size={12} className="mr-1" /> QC parameter</Button>
                </span>}
              </div>
              {x.qc_params?.length ? (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500"><tr>{['QC parameter', 'UOM', 'Min', 'Target', 'Max', 'Mandatory', 'Active', ''].map((h) => <th key={h} className="px-3 py-1.5 text-left">{h}</th>)}</tr></thead>
                  <tbody>{x.qc_params.map((q: any) => (
                    <tr key={q.id} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{q.param_name}</td><td className="px-3 py-1.5">{q.uom || '—'}</td><td className="px-3 py-1.5">{q.min_value ?? '—'}</td><td className="px-3 py-1.5">{q.target_value ?? '—'}</td>
                      <td className="px-3 py-1.5">{q.max_value ?? '—'}</td><td className="px-3 py-1.5">{yes(q.is_mandatory) ? 'Yes' : 'No'}</td><td className="px-3 py-1.5">{yes(q.is_active) ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-1.5 text-right">{master && <button className="p-1 text-slate-400 hover:text-brand-700" onClick={() => setP({ ...q, uom: q.uom ?? '', min_value: q.min_value ?? '', max_value: q.max_value ?? '', target_value: q.target_value ?? '', is_mandatory: yes(q.is_mandatory), is_active: yes(q.is_active) })}><Pencil size={13} /></button>}</td></tr>
                  ))}</tbody>
                </table>
              ) : <div className="px-4 py-2 text-[11.5px] text-slate-400">No QC parameters</div>}
            </div>
          ))}
        </div>
      )}
      {t && (
        <Modal open onClose={() => setT(null)} size="lg" title={t.id ? `Edit ${t.code}` : 'New yarn process type'} footer={<><Button variant="secondary" onClick={() => setT(null)}>Cancel</Button><Button loading={busy} onClick={saveType}>Save</Button></>}>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Code *" value={t.code} disabled={!!t.id} onChange={(e) => setT({ ...t, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
            <Input label="Name *" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
            <Select label="Base process *" value={t.base_process} onChange={(e) => setT({ ...t, base_process: e.target.value })} options={[{ value: 'YARN_DYEING', label: 'Yarn dyeing' }, { value: 'WINDING', label: 'Winding' }, { value: 'TWISTING', label: 'Twisting' }]} />
            <Select label="Process mode *" value={t.process_mode} onChange={(e) => setT({ ...t, process_mode: e.target.value })} options={Object.entries(MODE_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
            <Input label="Default ply" type="number" value={t.default_ply} onChange={(e) => setT({ ...t, default_ply: e.target.value })} />
            <Input label="Allowed ply (e.g. 2,3,4)" value={t.ply_options} onChange={(e) => setT({ ...t, ply_options: e.target.value })} />
            <Input label="Loss tolerance %" type="number" step="0.01" value={t.loss_tolerance_pct} onChange={(e) => setT({ ...t, loss_tolerance_pct: e.target.value })} />
            <Input label="Sort order" type="number" value={t.sort_order} onChange={(e) => setT({ ...t, sort_order: e.target.value })} />
            <div />
            <Checkbox label="Changes shade (dyeing)" checked={t.changes_shade} onChange={(v) => setT({ ...t, changes_shade: v })} />
            <Checkbox label="GRN requires QC before posting" checked={t.requires_qc} onChange={(v) => setT({ ...t, requires_qc: v })} />
            <Checkbox label="Billable (contractor charge)" checked={t.billable} onChange={(v) => setT({ ...t, billable: v })} />
            <Checkbox label="Allow reprocess" checked={t.allow_reprocess} onChange={(v) => setT({ ...t, allow_reprocess: v })} />
            <Checkbox label="Is a reprocess type" checked={t.is_reprocess} onChange={(v) => setT({ ...t, is_reprocess: v })} />
            <Checkbox label="Active" checked={t.is_active} onChange={(v) => setT({ ...t, is_active: v })} />
          </div>
        </Modal>
      )}
      {p && (
        <Modal open onClose={() => setP(null)} size="md" title={`${p.id ? 'Edit' : 'New'} QC parameter — ${p.process_code}`} footer={<><Button variant="secondary" onClick={() => setP(null)}>Cancel</Button><Button loading={busy} onClick={saveParam}>Save</Button></>}>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Parameter *" className="col-span-2" value={p.param_name} onChange={(e) => setP({ ...p, param_name: e.target.value })} />
            <Input label="UOM" value={p.uom} onChange={(e) => setP({ ...p, uom: e.target.value })} />
            <Input label="Min" type="number" step="0.001" value={p.min_value} onChange={(e) => setP({ ...p, min_value: e.target.value })} />
            <Input label="Target" type="number" step="0.001" value={p.target_value} onChange={(e) => setP({ ...p, target_value: e.target.value })} />
            <Input label="Max" type="number" step="0.001" value={p.max_value} onChange={(e) => setP({ ...p, max_value: e.target.value })} />
            <Checkbox label="Mandatory" checked={p.is_mandatory} onChange={(v) => setP({ ...p, is_mandatory: v })} />
            <Checkbox label="Active" checked={p.is_active} onChange={(v) => setP({ ...p, is_active: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
