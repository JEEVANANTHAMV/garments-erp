import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowRight, CheckCircle2, ArrowLeft } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { PageHeader, Button, Input, Select, LoadingBlock, SearchInput } from '../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useAuth } from '../../lib/auth';

/**
 * Job stock transfer (client voice note 01-Oct-2026): yarn lots, fabric rolls and trims bought for
 * one job (or for general stock) moved to another job — job-wise / style-wise, with a reason, and
 * fully traceable (the lot / roll keeps its GRN, PO and supplier).
 */
const MATERIALS = [['YARN', 'Yarn (lots)'], ['FABRIC', 'Fabric (rolls)'], ['TRIM', 'Trims & accessories']] as const;
const STATUS: Record<string, [string, string]> = {
  PENDING_APPROVAL: ['Waiting for approval', 'bg-amber-100 text-amber-800'], POSTED: ['Approved & posted', 'bg-emerald-100 text-emerald-800'],
  SEND_BACK: ['Sent back', 'bg-orange-100 text-orange-800'], REJECTED: ['Rejected', 'bg-rose-100 text-rose-700'], CANCELLED: ['Cancelled', 'bg-slate-200 text-slate-600'],
};
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as any)?.message || 'Failed');

export default function JobTransferPage() {
  const [mode, setMode] = useState<'list' | 'new'>('list');
  return mode === 'new' ? <TransferEditor onBack={() => setMode('list')} /> : <TransferList onNew={() => setMode('new')} />;
}

function TransferList({ onNew }: { onNew: () => void }) {
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const toast = useToast();
  const qc = useQueryClient();
  const { can, user } = useAuth() as any;
  const canApprove = can('JOB_TRANSFER.APPROVE');
  const act = async (r: any, action: 'approve' | 'reject' | 'send-back' | 'cancel') => {
    let remarks: string | null = null;
    if (action !== 'approve') { remarks = window.prompt(`${action === 'cancel' ? 'Cancel' : action === 'reject' ? 'Reject' : 'Send back'} ${r.transfer_no} — reason:`); if (!remarks) return; }
    else if (!window.confirm(`Approve ${r.transfer_no}? The stock moves ${r.from_job} → ${r.to_job} now.`)) return;
    try {
      const x = await http.post<{ message: string }>(`/job-transfers/${r.id}/${action}`, { remarks });
      toast((x as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['job-transfers'] }); void qc.invalidateQueries({ queryKey: ['job-stock'] });
    } catch (e) { toast(errText(e), 'error'); }
  };
  const list = useQuery({ queryKey: ['job-transfers'], queryFn: async () => (await http.get<{ data: any[] }>('/job-transfers')).data ?? [] });
  const pending = (list.data ?? []).filter((r) => r.status === 'PENDING_APPROVAL').length;
  const rows = (list.data ?? []).filter((r) => !st || r.status === st).filter((r) => !q || [r.transfer_no, r.from_job, r.to_job, r.reason, r.material_type].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader breadcrumb={['Inventory', 'Job Stock Transfer']} title="Job Stock Transfer" subtitle="Move yarn / fabric / trims job → job or general → job"
        actions={<Button onClick={onNew}><Plus size={14} className="mr-1" /> New Transfer</Button>} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Transfer no, job, reason…" className="w-72" />
          <select className="input w-48 py-1.5 text-xs" value={st} onChange={(e) => setSt(e.target.value)} id="jt-status">
            <option value="">All statuses</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
          {pending > 0 && <button className="rounded-full bg-amber-100 px-3 py-1 text-[11.5px] font-semibold text-amber-800" onClick={() => setSt('PENDING_APPROVAL')}>{pending} waiting for approval{canApprove ? ' — review' : ''}</button>}
        </div>
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Transfer no', 'Date', 'Material', 'From job', '', 'To job', 'To style', 'Lines', 'Qty', 'Reason', 'By', 'Status', ''].map((h, i) => <th key={i} className={`px-3 py-2 ${/Qty|Lines/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.transfer_no}</td><td className="px-3 py-2">{fmtDate(r.transfer_date)}</td>
                  <td className="px-3 py-2">{MATERIALS.find((m) => m[0] === r.material_type)?.[1]}</td><td className="px-3 py-2 font-semibold">{r.from_job}</td>
                  <td className="px-1 text-slate-400"><ArrowRight size={12} /></td><td className="px-3 py-2 font-semibold">{r.to_job}</td><td className="px-3 py-2">{r.to_style || '—'}</td>
                  <td className="px-3 py-2 text-right">{r.line_count}</td><td className="px-3 py-2 text-right">{fmtDecimal(r.total_qty, 3)}</td><td className="px-3 py-2">{r.reason}{r.decision_remarks ? <span className="block text-[10.5px] text-slate-500">↳ {r.decision_remarks}</span> : null}</td><td className="px-3 py-2">{r.created_by_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${STATUS[r.status ?? 'POSTED']?.[1] ?? ''}`}>{STATUS[r.status ?? 'POSTED']?.[0] ?? r.status}</span>
                    {r.priority && r.priority !== 'NORMAL' && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] font-bold text-rose-700">{r.priority}</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.status === 'PENDING_APPROVAL' && canApprove && <>
                      <button className="mr-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white" onClick={() => act(r, 'approve')} id={`jt-approve-${r.id}`}>Approve</button>
                      <button className="mr-1 rounded border border-amber-400 px-2 py-0.5 text-[11px] text-amber-800" onClick={() => act(r, 'send-back')}>Send back</button>
                      <button className="mr-1 rounded border border-rose-400 px-2 py-0.5 text-[11px] text-rose-700" onClick={() => act(r, 'reject')} id={`jt-reject-${r.id}`}>Reject</button>
                    </>}
                    {['PENDING_APPROVAL', 'SEND_BACK'].includes(r.status) && (Number(r.created_by) === Number(user?.id) || canApprove) && <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600" onClick={() => act(r, 'cancel')}>Cancel</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">No job transfers yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function TransferEditor({ onBack }: { onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: any[] }>('/procurement/jobs')).data ?? [] });
  const [head, setHead] = useState({ material_type: 'YARN', transfer_date: today(), from_so_id: '0', to_so_id: '', to_style_id: '', reason: '', priority: 'NORMAL' });
  const [sel, setSel] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const stock = useQuery({
    queryKey: ['job-stock', head.material_type, head.from_so_id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/job-stock?material=${head.material_type}&so_id=${head.from_so_id}`)).data ?? [],
  });
  const toJob = (jobs.data ?? []).find((j) => String(j.id) === head.to_so_id);
  const jobOpts = [{ value: '0', label: 'GENERAL (no job)' }, ...(jobs.data ?? []).map((j) => ({ value: String(j.id), label: `${j.job_no}${j.buyer_name ? ` · ${j.buyer_name}` : ''}` }))];
  const total = useMemo(() => Object.values(sel).reduce((a, v) => a + (Number(v) || 0), 0), [sel]);
  const save = async () => {
    if (head.to_so_id === '') { toast('Choose the job to transfer to', 'warning'); return; }
    if (head.to_so_id === head.from_so_id) { toast('From and to job are the same', 'warning'); return; }
    if (head.reason.trim().length < 3) { toast('Give the reason for the transfer', 'warning'); return; }
    const lines = Object.entries(sel).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ ref_id: Number(id), qty: Number(q) }));
    if (!lines.length) { toast('Pick what to transfer', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/job-transfers', { ...head, from_so_id: Number(head.from_so_id), to_so_id: Number(head.to_so_id), to_style_id: head.to_style_id ? Number(head.to_style_id) : null, lines });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['job-transfers'] }); void qc.invalidateQueries({ queryKey: ['job-stock'] }); onBack();
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader breadcrumb={['Inventory', 'Job Stock Transfer']} title="New Job Stock Transfer" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Select label="Material *" value={head.material_type} onChange={(e) => { setHead({ ...head, material_type: e.target.value }); setSel({}); }} options={MATERIALS.map(([v, l]) => ({ value: v, label: l }))} />
        <Input label="Transfer date *" type="date" value={head.transfer_date} onChange={(e) => setHead({ ...head, transfer_date: e.target.value })} />
        <Select label="From job *" value={head.from_so_id} onChange={(e) => { setHead({ ...head, from_so_id: e.target.value }); setSel({}); }} options={jobOpts} />
        <Select label="To job *" value={head.to_so_id} placeholder="—" onChange={(e) => setHead({ ...head, to_so_id: e.target.value, to_style_id: '' })} options={jobOpts.filter((o) => o.value !== head.from_so_id)} />
        <Select label="To style" value={head.to_style_id} placeholder="—" onChange={(e) => setHead({ ...head, to_style_id: e.target.value })} options={(toJob?.styles ?? []).map((s: any) => ({ value: s.style_id, label: `${s.style_code} — ${s.style_name}` }))} />
        <Input label="Reason *" value={head.reason} placeholder="e.g. Urgent — short for cutting" onChange={(e) => setHead({ ...head, reason: e.target.value })} />
        <Select label="Priority" value={head.priority} onChange={(e) => setHead({ ...head, priority: e.target.value })} options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'URGENT', label: 'Urgent' }, { value: 'EMERGENCY', label: 'Emergency' }]} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Item', 'Lot', 'Colour', 'Source (GRN / PO / supplier)', 'Store', 'Available', 'Transfer qty'].map((h, i) => <th key={i} className={`px-2 py-2 ${/Available|qty/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {stock.isLoading && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">Loading…</td></tr>}
            {(stock.data ?? []).map((r) => {
              const on = sel[r.ref_id] !== undefined;
              return (
                <tr key={r.ref_id} className={`border-t border-slate-100 ${on ? 'bg-emerald-50' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const c = { ...s }; if (on) delete c[r.ref_id]; else c[r.ref_id] = r.available; return c; })} /></td>
                  <td className="px-2 py-1 font-semibold">{r.item}{r.state && r.state !== 'GREY' ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">{r.state}</span> : null}</td>
                  <td className="px-2 py-1">{r.lot_no || '—'}</td><td className="px-2 py-1">{r.colour || '—'}</td><td className="px-2 py-1">{r.source}</td><td className="px-2 py-1">{r.store || '—'}</td>
                  <td className="px-2 py-1 text-right">{fmtDecimal(r.available, 3)} {r.uom}</td>
                  <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[r.ref_id]} onChange={(e) => setSel((s) => ({ ...s, [r.ref_id]: Number(e.target.value) }))} /> : '—'}</td>
                </tr>
              );
            })}
            {!stock.isLoading && !(stock.data ?? []).length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">The selected job holds no {head.material_type.toLowerCase()} stock</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={7} className="px-2 py-2 text-right">Total to transfer</td><td className="px-2 py-2 text-right">{fmtDecimal(total, 3)}</td></tr></tfoot>
        </table>
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500">Part of a fabric roll becomes a new roll for the target job (same GRN — traceable). Yarn lots keep their GRN / PO; only the job that may use them changes.</p>
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save}><CheckCircle2 size={14} className="mr-1" /> Post Transfer</Button></div>
    </>
  );
}
