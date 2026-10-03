import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, ShieldCheck } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { PageHeader, Button, Input, LoadingBlock } from '../../components/ui';
import { fmtDecimal } from '../../lib/format';

/**
 * Purchase Excess Limits (client voice note 03-Oct-2026): a job may buy each BOM material up to its requirement
 * plus an allowed excess (bag / cone / roll round-off). Company defaults per material, a job's own allowance, and
 * per item: requirement · allowed · ordered on POs · balance. POs above the limit are refused (BLOCK) or warned.
 */
type G = 'YARN' | 'FABRIC' | 'TRIM';
const GROUPS: [G, string, string][] = [['YARN', 'Yarn', 'KG'], ['FABRIC', 'Fabric', 'BOM UOM'], ['TRIM', 'Trims / accessories / packing', 'BOM UOM']];

export default function PurchaseExcessPage() {
  const { can } = useAuth();
  const editable = can('PURCHASE.APPROVE') || can('SETTINGS.UPDATE');
  return (
    <div className="space-y-4">
      <PageHeader title="Purchase Excess Limits" subtitle="How much a job may buy above its BOM requirement — allowed = requirement × (1 + %) + qty" />
      <Defaults editable={editable} />
      <JobLimits editable={editable} />
    </div>
  );
}

function Defaults({ editable }: { editable: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['purchase-excess-settings'], queryFn: async () => (await http.get<{ data: any }>('/purchase-excess/settings')).data });
  const [v, setV] = useState<any>(null);
  useEffect(() => { if (q.data) setV(JSON.parse(JSON.stringify(q.data))); }, [q.data]);
  const [busy, setBusy] = useState(false);
  if (!v) return <LoadingBlock />;
  const save = async () => {
    setBusy(true);
    try { const r = await http.put<any>('/purchase-excess/settings', v); toast(r.message, 'success'); void qc.invalidateQueries({ queryKey: ['purchase-excess-settings'] }); void qc.invalidateQueries({ queryKey: ['job-purchase-status'] }); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Save failed', 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4">
      <h3 className="mb-3 text-[13px] font-semibold text-slate-800">Company defaults (every job, unless the job has its own)</h3>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
        <span className="font-semibold text-slate-700">When a PO goes above the limit:</span>
        {[['BLOCK', 'Refuse the PO'], ['WARN', 'Save, but warn'], ['OFF', 'No check']].map(([k, l]) => (
          <label key={k} className="flex items-center gap-1.5"><input type="radio" name="pe-control" disabled={!editable} checked={v.control === k} onChange={() => setV({ ...v, control: k })} id={`pe-control-${k}`} /> {l}</label>
        ))}
      </div>
      <table className="w-full max-w-3xl text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2 text-left">Material</th><th className="px-3 py-2 text-left">Excess %</th><th className="px-3 py-2 text-left">+ Extra qty</th></tr></thead>
        <tbody>{GROUPS.map(([g, label, uom]) => (
          <tr key={g} className="border-t border-slate-100">
            <td className="px-3 py-1.5 font-medium">{label}</td>
            <td className="px-3 py-1.5"><input type="number" step="0.01" className="input w-28 py-1 text-right text-xs" disabled={!editable} value={v.defaults[g].pct} id={`pe-def-${g}-pct`}
              onChange={(e) => setV({ ...v, defaults: { ...v.defaults, [g]: { ...v.defaults[g], pct: e.target.value } } })} /> %</td>
            <td className="px-3 py-1.5"><input type="number" step="0.001" className="input w-28 py-1 text-right text-xs" disabled={!editable} value={v.defaults[g].qty} id={`pe-def-${g}-qty`}
              onChange={(e) => setV({ ...v, defaults: { ...v.defaults, [g]: { ...v.defaults[g], qty: e.target.value } } })} /> <span className="text-slate-400">{uom}</span></td>
          </tr>))}</tbody>
      </table>
      {editable && <div className="mt-3"><Button loading={busy} onClick={save} id="btn-save-pe-defaults"><Save size={14} className="mr-1" /> Save defaults</Button></div>}
    </div>
  );
}

function JobLimits({ editable }: { editable: boolean }) {
  const toast = useToast(); const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: any[] }>('/procurement/jobs')).data ?? [], staleTime: 60_000 });
  const [soId, setSoId] = useState('');
  const st = useQuery({ queryKey: ['job-purchase-status', soId], queryFn: async () => (await http.get<{ data: any }>(`/jobs/${soId}/purchase-status`)).data, enabled: !!soId });
  const [edit, setEdit] = useState<Record<string, { custom: boolean; pct: string; qty: string; remarks: string }>>({});
  useEffect(() => {
    const a = st.data?.allowances; if (!a) return;
    setEdit(Object.fromEntries((['YARN', 'FABRIC', 'TRIM'] as G[]).map((g) => [g, { custom: a[g].source === 'JOB', pct: String(a[g].pct), qty: String(a[g].qty), remarks: a[g].remarks ?? '' }])));
  }, [st.data]);
  const saveGroup = async (g: G) => {
    const e = edit[g];
    try {
      const r = await http.put<any>(`/jobs/${soId}/purchase-allowance`, { material_type: g, use_default: !e.custom, excess_pct: Number(e.pct) || 0, excess_qty: Number(e.qty) || 0, remarks: e.remarks || null });
      toast(r.message, 'success'); void qc.invalidateQueries({ queryKey: ['job-purchase-status', soId] });
    } catch (x) { toast(x instanceof ApiError ? x.message : 'Save failed', 'error'); }
  };
  const d = st.data;
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="block"><span className="label">Job (I/O)</span>
          <select className="input w-80" value={soId} onChange={(e) => setSoId(e.target.value)} id="pe-job">
            <option value="">— Select job —</option>
            {(jobs.data ?? []).map((j: any) => <option key={j.id} value={j.id}>{j.job_no}{j.buyer_name ? ` · ${j.buyer_name}` : ''}</option>)}
          </select></label>
        {d && <span className={`rounded px-2 py-1 text-[11px] font-semibold ${d.control === 'BLOCK' ? 'bg-red-50 text-red-800' : d.control === 'WARN' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
          <ShieldCheck size={12} className="mr-1 inline" />{d.control === 'BLOCK' ? 'POs above the limit are refused' : d.control === 'WARN' ? 'POs above the limit save with a warning' : 'No check'}</span>}
      </div>
      {soId && st.isLoading && <LoadingBlock />}
      {d && (
        <>
          {!d.has_bom && <p className="mb-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">This job has no BOM yet — its requirement (and so the limit) comes from the BOM.</p>}
          <div className="mb-3 grid gap-2 md:grid-cols-3">
            {GROUPS.map(([g, label]) => {
              const e = edit[g]; if (!e) return null;
              return (
                <div key={g} className="rounded-lg border border-slate-200 p-3 text-xs" id={`pe-job-${g}`}>
                  <div className="mb-2 flex items-center justify-between font-semibold text-slate-800">{label}
                    <label className="flex items-center gap-1 font-normal"><input type="checkbox" disabled={!editable} checked={e.custom} onChange={(x) => setEdit({ ...edit, [g]: { ...e, custom: x.target.checked } })} id={`pe-custom-${g}`} /> own allowance</label>
                  </div>
                  <div className="flex items-end gap-2">
                    <Input label="Excess %" type="number" className="w-24" disabled={!editable || !e.custom} value={e.pct} onChange={(x) => setEdit({ ...edit, [g]: { ...e, pct: x.target.value } })} id={`pe-${g}-pct`} />
                    <Input label="+ qty" type="number" className="w-24" disabled={!editable || !e.custom} value={e.qty} onChange={(x) => setEdit({ ...edit, [g]: { ...e, qty: x.target.value } })} id={`pe-${g}-qty`} />
                    {editable && <Button size="sm" onClick={() => void saveGroup(g)} id={`btn-pe-save-${g}`}>Save</Button>}
                  </div>
                  {e.custom && <Input label="Reason" className="mt-2" value={e.remarks} disabled={!editable} onChange={(x) => setEdit({ ...edit, [g]: { ...e, remarks: x.target.value } })} id={`pe-${g}-remarks`} placeholder="e.g. 25 KG bag round-off" />}
                  {!e.custom && <p className="mt-1 text-slate-500">Company default</p>}
                </div>
              );
            })}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs" id="pe-items">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Material', 'Type', 'UOM', 'Requirement (BOM)', 'Allowance', 'Allowed total', 'Ordered (POs)', 'Balance to buy', 'Over', 'POs'].map((h) => <th key={h} className={`px-2 py-2 ${/Requirement|Allowed|Ordered|Balance|Over/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {d.rows.map((r: any) => (
                  <tr key={r.key} className={`border-t border-slate-100 ${r.over > 0 ? 'bg-red-50/60' : ''}`}>
                    <td className="px-2 py-1.5 font-medium">{r.name}</td><td className="px-2 py-1.5">{r.material_type}</td><td className="px-2 py-1.5">{r.uom_code ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(r.required, 3)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.excess_pct}%{r.excess_qty ? ` + ${r.excess_qty}` : ''}{r.allowance_source === 'JOB' ? ' (job)' : ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{fmtDecimal(r.allowed, 3)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(r.ordered, 3)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.balance < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{fmtDecimal(Math.max(0, r.balance), 3)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-red-700">{r.over > 0 ? fmtDecimal(r.over, 3) : ''}</td>
                    <td className="px-2 py-1.5 font-mono text-[11px] text-slate-500">{r.pos ?? '—'}</td>
                  </tr>))}
                {!d.rows.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-slate-400">No BOM materials for this job</td></tr>}
              </tbody>
            </table>
          </div>
          {d.notes?.length > 0 && <ul className="mt-2 list-disc pl-5 text-[11px] text-slate-500">{d.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
        </>
      )}
    </div>
  );
}
