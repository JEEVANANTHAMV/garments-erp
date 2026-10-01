import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { PageHeader, Button, Input, Select, LoadingBlock } from '../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../lib/format';

/**
 * Yarn substitution (client voice note 02-Oct-2026; Full_Knitting_Module_Developer_Document §15–19):
 * the job needs 24s but 25s is in stock — the store raises a substitution request against the
 * knitting program's yarn line, within an approved rule (max %, conversion ratio); the Production
 * Manager approves and it posts (a lot of another job moves to this job). The original requirement
 * is never changed; the knitting DC then issues the substitute lot against the line.
 */
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as any)?.message || 'Failed');
const n = (v: unknown) => Number(v ?? 0) || 0;
const kg = (v: unknown) => fmtDecimal(n(v), 3);
const STATUS: Record<string, [string, string]> = {
  PENDING_APPROVAL: ['Waiting for approval', 'bg-amber-100 text-amber-800'], APPROVED: ['Approved', 'bg-sky-100 text-sky-800'],
  POSTED: ['Approved & posted', 'bg-emerald-100 text-emerald-800'], SEND_BACK: ['Sent back', 'bg-orange-100 text-orange-800'],
  REJECTED: ['Rejected', 'bg-rose-100 text-rose-700'], CANCELLED: ['Cancelled', 'bg-slate-200 text-slate-600'],
};
const Chip = ({ s }: { s: string }) => <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${STATUS[s]?.[1] ?? 'bg-slate-100'}`}>{STATUS[s]?.[0] ?? s}</span>;

export default function YarnSubstitutionPage() {
  const [tab, setTab] = useState<'requests' | 'new' | 'rules' | 'ledger'>('requests');
  const T = (k: typeof tab, label: string) => (
    <button key={k} id={`ys-tab-${k}`} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === k ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>
  );
  return (
    <>
      <PageHeader breadcrumb={['Production', 'Yarn Substitution']} title="Yarn Substitution" subtitle="Required count not in stock — use an approved substitute (e.g. 24s → 25s) with Production Manager approval" />
      <div className="mb-3 flex flex-wrap gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5">
        {T('requests', 'Requests & approvals')}{T('new', 'New request')}{T('rules', 'Substitution rules')}{T('ledger', 'Job yarn ledger')}
      </div>
      {tab === 'requests' && <RequestList />}
      {tab === 'new' && <NewRequest onDone={() => setTab('requests')} />}
      {tab === 'rules' && <Rules />}
      {tab === 'ledger' && <JobLedger />}
    </>
  );
}

function RequestList() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can, user } = useAuth() as any;
  const canApprove = can('YARN_SUBSTITUTION.APPROVE');
  const [st, setSt] = useState('');
  const list = useQuery({ queryKey: ['yarn-sub-requests', st], queryFn: async () => (await http.get<{ data: any[] }>(`/yarn-substitution-requests${st ? `?status=${st}` : ''}`)).data ?? [] });
  const act = async (r: any, action: 'approve' | 'reject' | 'send-back' | 'cancel') => {
    let remarks: string | null = null;
    if (action !== 'approve') { remarks = window.prompt(`${action} ${r.request_no} — reason:`); if (!remarks) return; }
    else if (!window.confirm(`Approve ${r.request_no}: ${kg(r.qty_kg)} KG ${r.substitute_yarn} for ${r.required_yarn}?`)) return;
    try {
      const x = await http.post<{ message: string }>(`/yarn-substitution-requests/${r.id}/${action}`, { remarks });
      toast((x as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-sub-requests'] }); void qc.invalidateQueries({ queryKey: ['knit-yarn-req'] });
    } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div className="card overflow-x-auto">
      <div className="border-b border-surface-border p-3">
        <select className="input w-56 py-1.5 text-xs" value={st} onChange={(e) => setSt(e.target.value)} id="ys-status">
          <option value="">All statuses</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
        </select>
      </div>
      {list.isLoading ? <LoadingBlock /> : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Request', 'Date', 'Job', 'Program', 'Required yarn', 'Substitute', 'Lot / GRN', 'From', 'Qty KG', '= Req. KG', 'Reason', 'By', 'Status', ''].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{r.request_no}</td><td className="px-2 py-1.5">{fmtDate(r.request_date)}</td>
                <td className="px-2 py-1.5 font-semibold">{r.io_no}</td><td className="px-2 py-1.5">{r.program_no}</td>
                <td className="px-2 py-1.5">{r.required_yarn}</td><td className="px-2 py-1.5 font-semibold text-purple-700">{r.substitute_yarn}</td>
                <td className="px-2 py-1.5">{r.lot_no || '—'} <span className="text-slate-400">{r.grn_no}</span></td><td className="px-2 py-1.5">{r.from_job}{r.transfer_no ? <span className="block text-[10px] text-slate-400">{r.transfer_no}</span> : null}</td>
                <td className="px-2 py-1.5 text-right">{kg(r.qty_kg)}</td><td className="px-2 py-1.5 text-right">{kg(r.equivalent_kg)}</td>
                <td className="px-2 py-1.5">{r.reason}{r.decision_remarks ? <span className="block text-[10.5px] text-slate-500">↳ {r.decision_remarks}</span> : null}</td>
                <td className="px-2 py-1.5">{r.requested_by}{r.approved_by_name ? <span className="block text-[10px] text-slate-400">appr. {r.approved_by_name}</span> : null}</td>
                <td className="px-2 py-1.5"><Chip s={r.status} /></td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {r.status === 'PENDING_APPROVAL' && canApprove && <>
                    <button className="mr-1 rounded bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white" onClick={() => act(r, 'approve')} id={`ys-approve-${r.id}`}>Approve</button>
                    <button className="mr-1 rounded border border-amber-400 px-2 py-0.5 text-[11px] text-amber-800" onClick={() => act(r, 'send-back')}>Send back</button>
                    <button className="mr-1 rounded border border-rose-400 px-2 py-0.5 text-[11px] text-rose-700" onClick={() => act(r, 'reject')} id={`ys-reject-${r.id}`}>Reject</button>
                  </>}
                  {['PENDING_APPROVAL', 'SEND_BACK'].includes(r.status) && (Number(r.created_by) === Number(user?.id) || canApprove) && <button className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600" onClick={() => act(r, 'cancel')}>Cancel</button>}
                </td>
              </tr>
            ))}
            {!(list.data ?? []).length && <tr><td colSpan={14} className="px-3 py-10 text-center text-slate-400">No substitution requests</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewRequest({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [programId, setProgramId] = useState('');
  const [pyId, setPyId] = useState('');
  const [lotKey, setLotKey] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const programs = useQuery({ queryKey: ['knitting-programs', 'for-sub'], queryFn: async () => (await http.get<{ data: any[] }>('/knitting/programs?pageSize=200')).data ?? [] });
  const reqs = useQuery({ queryKey: ['knit-yarn-req', Number(programId)], queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-programs/${programId}/yarn-requirements`)).data ?? [], enabled: !!programId });
  const opts = useQuery({ queryKey: ['yarn-sub-options', pyId], queryFn: async () => (await http.get<{ data: any }>(`/yarn-substitution/options?program_yarn_id=${pyId}`)).data, enabled: !!pyId });
  const o = opts.data;
  const lot = (o?.lots ?? []).find((l: any) => `${l.rule_id}|${l.grn_line_id}|${l.holder_so_id ?? 0}` === lotKey);
  const maxKg = o && lot ? Math.max(0, n(o.required) * n(lot.max_pct) / 100 - n(o.posted_eq) - n(o.open_eq)) / (n(lot.conversion_ratio) || 1) : 0;

  const save = async () => {
    if (!lot) { toast('Pick the substitute lot', 'warning'); return; }
    if (!(n(qty) > 0)) { toast('Enter the substitute KG', 'warning'); return; }
    if (reason.trim().length < 3) { toast('Give the reason', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ message: string }>('/yarn-substitution-requests', {
        request_date: date, program_yarn_id: Number(pyId), rule_id: Number(lot.rule_id), grn_line_id: Number(lot.grn_line_id), from_so_id: Number(lot.holder_so_id ?? 0), qty_kg: n(qty), reason: reason.trim(),
      });
      toast((r as any).message, 'success');
      void qc.invalidateQueries({ queryKey: ['yarn-sub-requests'] }); void qc.invalidateQueries({ queryKey: ['knit-yarn-req'] });
      onDone();
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
        <Input label="Request date *" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Select label="Knitting program *" value={programId} placeholder="— Program —" id="ys-program" onChange={(e) => { setProgramId(e.target.value); setPyId(''); setLotKey(''); }}
          options={(programs.data ?? []).filter((p: any) => !['CANCELLED', 'CLOSED'].includes(p.status)).map((p: any) => ({ value: String(p.id), label: `${p.program_no} · ${p.io_no ?? '—'}${p.fabric_name ? ` · ${p.fabric_name}` : ''}` }))} />
        <Select label="Required yarn line *" value={pyId} placeholder={programId ? '— Yarn —' : 'pick the program'} id="ys-line" onChange={(e) => { setPyId(e.target.value); setLotKey(''); }}
          options={(reqs.data ?? []).map((l: any) => ({ value: String(l.program_yarn_id), label: `${l.yarn_name} · req ${kg(l.required_kg)} · pending ${kg(l.pending_kg)} KG` }))} />
      </div>
      {o && (
        <div className="card p-4 text-xs">
          <div className="mb-3 flex flex-wrap gap-6">
            <span>Required <b>{kg(o.required)}</b> KG</span><span>Issued <b>{kg(o.issued)}</b></span>
            <span>Substitute posted <b>{kg(o.posted_eq)}</b></span><span>Waiting approval <b>{kg(o.open_eq)}</b></span>
            <span className="font-semibold text-orange-700">Shortage {kg(o.shortage)} KG</span>
          </div>
          {!o.rules.length ? (
            <p className="text-amber-700">No active substitution rule allows a substitute for {o.line.yarn_name}. Add the rule in "Substitution rules" (Production Manager).</p>
          ) : (
            <>
              <p className="mb-1.5 font-semibold text-slate-700">Substitute lots in stock (allowed by the rules)</p>
              <table className="w-full">
                <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Substitute yarn', 'Lot', 'GRN', 'Supplier', 'Held by', 'Available KG', 'Ratio', 'Max %'].map((h, i) => <th key={i} className={`px-2 py-1.5 ${/KG|Ratio|Max/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {o.lots.map((l: any) => { const k = `${l.rule_id}|${l.grn_line_id}|${l.holder_so_id ?? 0}`; return (
                    <tr key={k} className={`border-t border-slate-100 ${lotKey === k ? 'bg-brand-50' : ''}`}>
                      <td className="px-2 py-1"><input type="radio" name="ys-lot" checked={lotKey === k} onChange={() => setLotKey(k)} id={`ys-lot-${l.grn_line_id}`} /></td>
                      <td className="px-2 py-1 font-semibold text-purple-700">{l.yarn_name}</td><td className="px-2 py-1">{l.lot_no || '—'}</td><td className="px-2 py-1">{l.grn_no}</td><td className="px-2 py-1">{l.supplier_name}</td>
                      <td className="px-2 py-1">{l.own ? <b>This job</b> : l.holder_job}{!l.own && <span className="block text-[10px] text-amber-700">moves to this job on approval</span>}</td>
                      <td className="px-2 py-1 text-right">{kg(l.available_kg)}</td><td className="px-2 py-1 text-right">{fmtDecimal(l.conversion_ratio, 3)}</td><td className="px-2 py-1 text-right">{fmtDecimal(l.max_pct, 2)}%</td>
                    </tr>
                  ); })}
                  {!o.lots.length && <tr><td colSpan={9} className="px-2 py-6 text-center text-slate-400">No stock of the allowed substitute yarns</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
      {lot && (
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Input label={`Substitute KG * (max ${kg(Math.min(maxKg, n(lot.available_kg)))})`} type="number" value={qty} id="ys-qty" onChange={(e) => setQty(e.target.value)} />
          <div className="text-xs"><div className="text-slate-500">Covers required</div><div className="text-base font-semibold">{kg(n(qty) * n(lot.conversion_ratio))} KG</div></div>
          <Input label="Reason *" className="col-span-2" value={reason} id="ys-reason" placeholder="e.g. 24s not available, 25s in stock — delivery urgent" onChange={(e) => setReason(e.target.value)} />
          <div className="col-span-full flex justify-end"><Button loading={busy} onClick={save} id="btn-ys-save">Send for approval</Button></div>
        </div>
      )}
    </div>
  );
}

const blankRule = { id: 0, required_yarn_id: '', substitute_yarn_id: '', fabric_id: '', buyer_id: '', style_id: '', gsm_from: '', gsm_to: '', max_pct: '10', conversion_ratio: '1', effective_from: '', effective_to: '', remarks: '', is_active: true };
function Rules() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth() as any;
  const canEdit = can('YARN_SUBSTITUTION.APPROVE');
  const yarns = useLookup('yarns'); const fabrics = useLookup('fabrics'); const buyers = useLookup('buyers'); const styles = useLookup('styles');
  const list = useQuery({ queryKey: ['yarn-sub-rules'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-substitution-rules')).data ?? [] });
  const [f, setF] = useState<any>(null);
  const opt = (d: any) => (d.data ?? []).map((x: any) => ({ value: String(x.id), label: x.code ? `${x.code} — ${x.label}` : x.label }));
  const save = async () => {
    const body: any = { ...f };
    ['fabric_id', 'buyer_id', 'style_id', 'gsm_from', 'gsm_to', 'effective_from', 'effective_to', 'remarks'].forEach((k) => { if (body[k] === '') body[k] = null; });
    delete body.id;
    try {
      const r = f.id ? await http.put<{ message: string }>(`/yarn-substitution-rules/${f.id}`, body) : await http.post<{ message: string }>('/yarn-substitution-rules', body);
      toast((r as any).message ?? 'Saved', 'success'); setF(null); void qc.invalidateQueries({ queryKey: ['yarn-sub-rules'] });
    } catch (e) { toast(errText(e), 'error'); }
  };
  const s = (x: any) => (x == null ? '' : String(x).slice(0, 10));
  return (
    <div className="space-y-3">
      {canEdit && !f && <Button onClick={() => setF({ ...blankRule })} id="btn-ys-rule-new"><Plus size={14} className="mr-1" /> New rule</Button>}
      {f && (
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
          <Select label="Required yarn *" value={f.required_yarn_id} placeholder="—" id="ysr-req" onChange={(e) => setF({ ...f, required_yarn_id: e.target.value })} options={opt(yarns)} />
          <Select label="Substitute yarn *" value={f.substitute_yarn_id} placeholder="—" id="ysr-sub" onChange={(e) => setF({ ...f, substitute_yarn_id: e.target.value })} options={opt(yarns)} />
          <Input label="Max % of requirement *" type="number" value={f.max_pct} id="ysr-max" onChange={(e) => setF({ ...f, max_pct: e.target.value })} />
          <Input label="Conversion ratio (1 KG sub = ? KG req)" type="number" value={f.conversion_ratio} onChange={(e) => setF({ ...f, conversion_ratio: e.target.value })} />
          <Select label="Only for fabric" value={f.fabric_id} placeholder="Any" onChange={(e) => setF({ ...f, fabric_id: e.target.value })} options={opt(fabrics)} />
          <Select label="Only for buyer" value={f.buyer_id} placeholder="Any" onChange={(e) => setF({ ...f, buyer_id: e.target.value })} options={opt(buyers)} />
          <Select label="Only for style" value={f.style_id} placeholder="Any" onChange={(e) => setF({ ...f, style_id: e.target.value })} options={opt(styles)} />
          <Input label="GSM from" type="number" value={f.gsm_from} onChange={(e) => setF({ ...f, gsm_from: e.target.value })} />
          <Input label="GSM to" type="number" value={f.gsm_to} onChange={(e) => setF({ ...f, gsm_to: e.target.value })} />
          <Input label="Effective from" type="date" value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />
          <Input label="Effective to" type="date" value={f.effective_to} onChange={(e) => setF({ ...f, effective_to: e.target.value })} />
          <label className="flex items-center gap-2 pt-5 text-xs"><input type="checkbox" checked={!!f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>
          <Input label="Remarks" className="col-span-2 md:col-span-4" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
          <div className="col-span-2 flex items-end justify-end gap-2"><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button onClick={save} id="btn-ysr-save">Save rule</Button></div>
        </div>
      )}
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Required', 'Substitute', 'Max %', 'Ratio', 'Fabric', 'Buyer', 'Style', 'GSM', 'Effective', 'Active', ''].map((h) => <th key={h} className="px-2 py-2 text-left">{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-semibold">{r.required_yarn}</td><td className="px-2 py-1.5 font-semibold text-purple-700">{r.substitute_yarn}</td>
                  <td className="px-2 py-1.5">{fmtDecimal(r.max_pct, 2)}%</td><td className="px-2 py-1.5">{fmtDecimal(r.conversion_ratio, 3)}</td>
                  <td className="px-2 py-1.5">{r.fabric_name || 'Any'}</td><td className="px-2 py-1.5">{r.buyer_name || 'Any'}</td><td className="px-2 py-1.5">{r.style_code || 'Any'}</td>
                  <td className="px-2 py-1.5">{r.gsm_from || r.gsm_to ? `${r.gsm_from ?? ''}–${r.gsm_to ?? ''}` : 'Any'}</td>
                  <td className="px-2 py-1.5">{r.effective_from || r.effective_to ? `${fmtDate(r.effective_from) || '…'} → ${fmtDate(r.effective_to) || '…'}` : 'Always'}</td>
                  <td className="px-2 py-1.5">{Number(r.is_active) ? 'Yes' : 'No'}</td>
                  <td className="px-2 py-1.5">{canEdit && <button className="text-brand-700 hover:underline" onClick={() => setF({ ...blankRule, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : v])), is_active: !!Number(r.is_active),
                    required_yarn_id: String(r.required_yarn_id), substitute_yarn_id: String(r.substitute_yarn_id), fabric_id: s(r.fabric_id), buyer_id: s(r.buyer_id), style_id: s(r.style_id), effective_from: s(r.effective_from), effective_to: s(r.effective_to) })}>Edit</button>}</td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={11} className="px-3 py-10 text-center text-slate-400">No substitution rules — the Production Manager adds which yarn may replace which (e.g. 24s → 25s, max 10%)</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function JobLedger() {
  const [soId, setSoId] = useState('');
  const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: any[] }>('/procurement/jobs')).data ?? [] });
  const led = useQuery({ queryKey: ['job-yarn-ledger', soId], queryFn: async () => (await http.get<{ data: any }>(`/jobs/${soId}/yarn-ledger`)).data, enabled: !!soId });
  const rows: any[] = led.data?.rows ?? [];
  // running balance per yarn (requirement is shown, not netted)
  const bal = new Map<number, number>();
  const withBal = rows.map((r) => { if (r.type !== 'REQUIREMENT') bal.set(r.yarn_id, (bal.get(r.yarn_id) ?? 0) + n(r.in_kg) - n(r.out_kg)); return { ...r, bal: r.type === 'REQUIREMENT' ? null : bal.get(r.yarn_id) }; });
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <Select label="Job" value={soId} placeholder="— Job —" id="ys-ledger-job" onChange={(e) => setSoId(e.target.value)}
          options={(jobs.data ?? []).map((j: any) => ({ value: String(j.id), label: `${j.job_no ?? j.io_no ?? j.so_no}${j.buyer_name ? ` · ${j.buyer_name}` : ''}` }))} />
        {soId && <Button variant="secondary" onClick={() => setSoId('')}><ArrowLeft size={14} className="mr-1" /> Clear</Button>}
      </div>
      {soId && (
        <div className="card overflow-x-auto">
          {led.isLoading ? <LoadingBlock /> : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Date', 'Type', 'Ref', 'Yarn', 'Lot', 'In KG', 'Out KG', 'Balance', 'Rate', 'Value'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Balance|Rate|Value/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {withBal.map((r, i) => (
                  <tr key={i} className={`border-t border-slate-100 ${r.type === 'REQUIREMENT' ? 'bg-slate-50 text-slate-500' : ''}`}>
                    <td className="px-2 py-1">{fmtDate(r.dt)}</td><td className="px-2 py-1 font-semibold">{r.type}</td><td className="px-2 py-1 font-mono">{r.ref}</td>
                    <td className="px-2 py-1">{r.yarn_name}</td><td className="px-2 py-1">{r.lot_no || '—'}</td>
                    <td className="px-2 py-1 text-right text-emerald-700">{n(r.in_kg) ? kg(r.in_kg) : ''}</td><td className="px-2 py-1 text-right text-rose-700">{n(r.out_kg) ? kg(r.out_kg) : ''}</td>
                    <td className="px-2 py-1 text-right">{r.bal != null ? kg(r.bal) : ''}</td><td className="px-2 py-1 text-right">{n(r.rate) ? fmtDecimal(r.rate, 2) : ''}</td>
                    <td className="px-2 py-1 text-right">{n(r.amount) ? `₹${fmtDecimal(r.amount, 2)}` : ''}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No yarn movement for this job</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
