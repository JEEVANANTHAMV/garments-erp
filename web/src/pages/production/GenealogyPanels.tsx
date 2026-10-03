import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Scissors, Combine } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { Button, Input } from '../../components/ui';
import { fmtDecimal } from '../../lib/format';
import { JobSelect } from '../../components/JobSelect';

/**
 * Job material genealogy panels (client document 03-Oct-2026): the clickable job genealogy tree (§27), the job
 * material requirement snapshot (§5.1), standard vs actual job cost and the cost a roll carries (§21), and roll
 * split / merge keeping the parent → child genealogy (§5.3, §6).
 */
const kg = (v: unknown) => fmtDecimal(Number(v ?? 0), 3);
const money = (v: unknown) => `₹${fmtDecimal(Number(v ?? 0), 2)}`;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as any)?.message || 'Failed');

type Node = { key: string; label: string; sub?: string; link?: string; roll_id?: number; kind: string; children?: Node[] };
const TONE: Record<string, string> = {
  JOB: 'bg-brand-600 text-white', BOM: 'bg-amber-100 text-amber-900', REQ: 'bg-amber-50 text-amber-800', SNAPSHOT: 'bg-amber-50 text-amber-800', GRN: 'bg-sky-100 text-sky-900',
  PROGRAM: 'bg-indigo-100 text-indigo-900', DC: 'bg-slate-100 text-slate-700', PRODUCTION: 'bg-emerald-100 text-emerald-900', ROLL: 'bg-white border border-slate-300 text-slate-800',
  PROCESS: 'bg-purple-100 text-purple-900', GROUP: 'bg-slate-50 text-slate-600',
};

/** §27 — every node opens the transaction behind it (rolls open their reverse trace). */
export function JobGenealogyTree({ soId, onRoll }: { soId: string; onRoll: (rollNo: string) => void }) {
  const q = useQuery({ queryKey: ['genealogy-tree', soId], queryFn: async () => (await http.get<{ data: Node }>(`/jobs/${soId}/genealogy-tree`)).data, enabled: !!soId });
  if (!q.data) return null;
  return (
    <div className="card mb-3 p-4 text-xs" id="genealogy-tree">
      <h3 className="mb-2 text-[13px] font-semibold text-slate-800">Job genealogy — click a node to open it</h3>
      <TreeNode node={q.data} depth={0} onRoll={onRoll} />
    </div>
  );
}
function TreeNode({ node, depth, onRoll }: { node: Node; depth: number; onRoll: (rollNo: string) => void }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(depth < 2);
  const kids = node.children ?? [];
  const click = () => { if (node.roll_id) onRoll(node.label); else if (node.link) nav(node.link); else if (kids.length) setOpen(!open); };
  return (
    <div style={{ marginLeft: depth ? 16 : 0 }} className="border-l border-slate-200 pl-2">
      <div className="flex items-center gap-1 py-0.5">
        {kids.length ? <button type="button" className="text-slate-400" onClick={() => setOpen(!open)} aria-label="toggle">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="w-[13px]" />}
        <button type="button" onClick={click} data-node={node.kind} data-label={node.label}
          className={`rounded px-1.5 py-0.5 text-left font-semibold ${TONE[node.kind] ?? 'bg-slate-100'} ${node.link || node.roll_id ? 'hover:underline' : ''}`}>{node.label}</button>
        {node.sub && <span className="text-slate-500">{node.sub}</span>}
      </div>
      {open && kids.map((c) => <TreeNode key={c.key} node={c} depth={depth + 1} onRoll={onRoll} />)}
    </div>
  );
}

/** §5.1 — the job's planned requirement frozen by revision (the BOM itself is never overwritten). */
export function RequirementSnapshot({ soId }: { soId: string }) {
  const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['job-requirement', soId], queryFn: async () => (await http.get<{ data: any }>(`/jobs/${soId}/requirement`)).data, enabled: !!soId });
  const [busy, setBusy] = useState(false);
  const take = async () => {
    setBusy(true);
    try { const r = await http.post<any>(`/jobs/${soId}/requirement-snapshot`, { remarks: 'Taken from Material Traceability' }); toast(r.message, 'success');
      void qc.invalidateQueries({ queryKey: ['job-requirement', soId] }); void qc.invalidateQueries({ queryKey: ['job-genealogy', soId] }); void qc.invalidateQueries({ queryKey: ['genealogy-tree', soId] }); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const a = q.data?.active ?? [];
  return (
    <div className="card mb-3 p-4 text-xs" id="requirement-snapshot">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-slate-800">Job material requirement {a.length ? `— revision ${a[0].revision_no}` : ''}</h3>
        <Button size="sm" variant="secondary" loading={busy} onClick={take} id="btn-take-snapshot">{a.length ? 'Take a new revision' : 'Take snapshot from BOM'}</Button>
      </div>
      {a.length ? (
        <table className="w-full"><thead className="bg-slate-50 text-slate-500"><tr>{['Material', 'Type', 'BOM', 'Planned', 'UOM', 'Taken by', 'On'].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>{a.map((r: any) => <tr key={r.id} className="border-t border-slate-100"><td className="px-2 py-1">{r.material_name}</td><td className="px-2 py-1">{r.material_type}</td><td className="px-2 py-1">{r.bom_no}</td>
            <td className="px-2 py-1 tabular-nums font-semibold">{kg(r.required_qty)}</td><td className="px-2 py-1">{r.uom_code ?? '—'}</td><td className="px-2 py-1">{r.created_by_name ?? '—'}</td><td className="px-2 py-1">{String(r.created_at).slice(0, 10)}</td></tr>)}</tbody></table>
      ) : <p className="text-slate-500">No snapshot yet — it is taken with the job's first knitting program, or take it now. Planned figures then stay fixed even if the BOM changes.</p>}
      {(q.data?.revisions?.length ?? 0) > 1 && <p className="mt-1 text-slate-500">Older revisions kept: {q.data.revisions.slice(1).join(', ')}</p>}
    </div>
  );
}

/** §21 — standard (BOM) cost and actual cost of the job, side by side, never mixed. */
export function JobCostPanel({ soId }: { soId: string }) {
  const q = useQuery({ queryKey: ['job-cost', soId], queryFn: async () => (await http.get<{ data: any }>(`/jobs/${soId}/cost`)).data, enabled: !!soId });
  const d = q.data; if (!d) return null;
  return (
    <div className="card mb-3 grid gap-4 p-4 text-xs md:grid-cols-2" id="job-cost">
      <div><h3 className="mb-1 text-[13px] font-semibold text-slate-800">Standard cost (BOM)</h3>
        {d.standard.length ? d.standard.map((x: any) => <div key={x.head} className="flex justify-between border-b border-slate-100 py-0.5"><span>{x.head}</span><span className="font-mono">{money(x.amount)}</span></div>) : <p className="text-slate-400">No BOM</p>}
        <div className="flex justify-between pt-1 font-semibold"><span>Total</span><span className="font-mono">{money(d.standard_total)}</span></div></div>
      <div><h3 className="mb-1 text-[13px] font-semibold text-slate-800">Actual cost</h3>
        {d.actual.filter((x: any) => x.amount).map((x: any) => <div key={x.head} className="flex justify-between border-b border-slate-100 py-0.5"><span>{x.head}{x.kg ? ` (${kg(x.kg)} KG)` : ''}</span><span className="font-mono">{money(x.amount)}</span></div>)}
        <div className="flex justify-between pt-1 font-semibold"><span>Total</span><span className="font-mono" id="job-cost-actual">{money(d.actual_total)}</span></div></div>
    </div>
  );
}

/** §21 — the cost per KG a roll carries, step by step. */
export function RollCostPanel({ rollId }: { rollId: number }) {
  const q = useQuery({ queryKey: ['roll-cost', rollId], queryFn: async () => (await http.get<{ data: any }>(`/fabric-rolls/${rollId}/cost`)).data, enabled: !!rollId });
  const d = q.data; if (!d) return null;
  return (
    <div className="card p-4 text-xs" id="roll-cost">
      <h3 className="mb-1 text-[13px] font-semibold text-slate-800">Cost carried by {d.roll_no}: <span id="roll-cost-kg">{money(d.cost_per_kg)}</span> / KG · value of the KG left {money(d.value)}</h3>
      <table className="w-full max-w-2xl"><tbody>{d.steps.map((s: any, i: number) => <tr key={i} className="border-t border-slate-100"><td className="px-2 py-0.5 font-semibold">{s.stage}</td><td className="px-2 py-0.5">{s.ref}</td><td className="px-2 py-0.5 text-slate-500">{s.note}</td><td className="px-2 py-0.5 text-right font-mono">{money(s.rate)}</td></tr>)}</tbody></table>
    </div>
  );
}

/** §5.3 — split the KG left on a roll into child rolls. */
export function SplitRollPanel({ roll, onDone }: { roll: { id: number; roll_no: string; weight_kg: number; issued_kg?: number }; onDone: (msg: string) => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const left = Math.round((Number(roll.weight_kg) - Number(roll.issued_kg ?? 0)) * 1000) / 1000;
  const [parts, setParts] = useState<string[]>([String(Math.round(left / 2 * 1000) / 1000), String(Math.round((left - Math.round(left / 2 * 1000) / 1000) * 1000) / 1000)]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const sum = Math.round(parts.reduce((a, x) => a + (Number(x) || 0), 0) * 1000) / 1000;
  const go = async () => {
    setBusy(true);
    try { const r = await http.post<any>(`/fabric-rolls/${roll.id}/split`, { parts: parts.map(Number), reason }); toast(r.message, 'success'); void qc.invalidateQueries(); onDone(r.message); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 text-xs" id="split-roll">
      <h3 className="mb-2 flex items-center gap-1 text-[13px] font-semibold text-slate-800"><Scissors size={14} /> Split {roll.roll_no} ({kg(left)} KG left)</h3>
      <div className="flex flex-wrap items-end gap-2">
        {parts.map((p, i) => <Input key={i} label={`Roll ${i + 1} KG`} type="number" className="w-24" value={p} id={`split-part-${i}`} onChange={(e) => setParts(parts.map((x, k) => (k === i ? e.target.value : x)))} />)}
        <Button size="sm" variant="secondary" onClick={() => setParts([...parts, '0'])}>+ part</Button>
        {parts.length > 2 && <Button size="sm" variant="secondary" onClick={() => setParts(parts.slice(0, -1))}>− part</Button>}
        <Input label="Reason *" className="w-64" value={reason} id="split-reason" onChange={(e) => setReason(e.target.value)} placeholder="e.g. two cut orders" />
        <Button size="sm" loading={busy} onClick={go} disabled={Math.abs(sum - left) > 0.001 || reason.trim().length < 3} id="btn-split">Split</Button>
      </div>
      <p className={`mt-1 ${Math.abs(sum - left) > 0.001 ? 'text-amber-700' : 'text-slate-500'}`}>Parts total {kg(sum)} KG — must equal {kg(left)} KG. The roll is closed and each part becomes a child roll of the same job, fabric and lot.</p>
    </div>
  );
}

/** §5.3 — merge rolls of the same job / fabric / state / colour / GSM / Dia / store: pick the job, tick its rolls. */
export function MergeRollsPanel({ onDone }: { onDone: (msg: string) => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [job, setJob] = useState<{ id: number; job_no: string } | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const rolls = useQuery({ queryKey: ['job-rolls', job?.id], queryFn: async () => (await http.get<{ data: any[] }>(`/jobs/${job!.id}/rolls`)).data ?? [], enabled: !!job });
  const open = (rolls.data ?? []).filter((r) => r.qc_status === 'ACCEPTED' && r.stock_status !== 'CLOSED' && Number(r.weight_kg) - Number(r.issued_kg) > 0.0005);
  const go = async () => {
    setBusy(true);
    try { const r = await http.post<any>('/fabric-rolls/merge', { roll_ids: sel, reason }); toast(r.message, 'success'); void qc.invalidateQueries(); onDone(r.message); setSel([]); setReason(''); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 text-xs" id="merge-rolls">
      <h3 className="mb-2 flex items-center gap-1 text-[13px] font-semibold text-slate-800"><Combine size={14} /> Merge rolls</h3>
      <div className="mb-2 flex flex-wrap items-end gap-2">
        <JobSelect label="Job" className="w-72" value={job?.job_no ?? ''} id="merge-job" onPick={(j) => { setJob(j ? { id: j.id, job_no: j.job_no } : null); setSel([]); }} />
        <Input label="Reason *" className="w-64" value={reason} id="merge-reason" onChange={(e) => setReason(e.target.value)} placeholder="e.g. small ends of one lot" />
        <Button size="sm" loading={busy} onClick={go} disabled={sel.length < 2 || reason.trim().length < 3} id="btn-merge">Merge {sel.length || ''} rolls</Button>
      </div>
      {job && (
        <table className="w-full" id="merge-table"><thead className="bg-slate-50 text-slate-500"><tr>{['', 'Roll', 'Fabric', 'State', 'Colour', 'GSM', 'Dia', 'Store', 'KG left'].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>{open.map((r) => <tr key={r.id} className="border-t border-slate-100" data-roll={r.roll_no}>
            <td className="px-2 py-1"><input type="checkbox" checked={sel.includes(Number(r.id))} onChange={(e) => setSel(e.target.checked ? [...sel, Number(r.id)] : sel.filter((x) => x !== Number(r.id)))} /></td>
            <td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.fabric_name}</td><td className="px-2 py-1">{r.process_state}</td><td className="px-2 py-1">{r.color_name ?? '—'}</td>
            <td className="px-2 py-1">{r.gsm ?? '—'}</td><td className="px-2 py-1">{r.dia ?? '—'}</td><td className="px-2 py-1">{r.warehouse_name}</td><td className="px-2 py-1 tabular-nums">{kg(Number(r.weight_kg) - Number(r.issued_kg))}</td></tr>)}
            {!open.length && <tr><td colSpan={9} className="px-2 py-3 text-center text-slate-400">No open rolls</td></tr>}</tbody></table>
      )}
      <p className="mt-1 text-slate-500">Only rolls of the same job, fabric, process state, colour, GSM, Dia and store, not on a draft DC or a live quotation. The KG left on each goes into one new roll; the source rolls are closed and stay in the genealogy.</p>
    </div>
  );
}
