import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Search, Download } from 'lucide-react';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { Button, Input, Select, Tabs, LoadingBlock, Modal, Checkbox } from '../../../components/ui';
import { fmtDate, fmtDecimal } from '../../../lib/format';
import { FpTitle, FpStatus, useProcessTypes, errText, kg } from './shared';

/**
 * Fabric Process — Process Types & QC (doc §22: configurable engine): process types (output state,
 * colour change, reprocess / split, "requires QC"), the QC parameters of each type (min / max /
 * target, mandatory) and the return / billing reasons.
 */
const STATES = ['DYED', 'WASHED', 'PRINTED', 'COMPACTED', 'FINISHED'];
const BILLING = ['BILLABLE', 'NON_BILLABLE', 'INTERNAL_COST', 'FREE', 'RECOVERY'];
const yes = (v: unknown) => !!Number(v);

export function FabricProcessMastersPage() {
  const [tab, setTab] = useState('types');
  return (
    <div>
      <FpTitle no={8} title="Process Types & QC" sub="Process types, QC parameters per process and return / billing reasons" />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'types', label: 'Process types & QC parameters' }, { key: 'reasons', label: 'Reasons' }]} active={tab} onChange={setTab} /></div>
      {tab === 'types' ? <TypesTab /> : <ReasonsTab />}
    </div>
  );
}

function TypesTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const master = can('FABRIC_PROCESS.MASTER');
  const q = useQuery({ queryKey: ['fabric-process', 'types', 'all'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/types/all')).data ?? [] });
  const [type, setType] = useState<any>(null);
  const [param, setParam] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['fabric-process', 'types'] }); };
  const saveType = async () => {
    setBusy(true);
    try {
      const body = { ...type, sort_order: Number(type.sort_order) || 0 };
      const r = type.id ? await http.put(`/fabric-process/types/${type.id}`, body) : await http.post('/fabric-process/types', body);
      toast((r as any).message, 'success'); setType(null); refresh();
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const saveParam = async () => {
    setBusy(true);
    const num = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
    try {
      const body = { ...param, min_value: num(param.min_value), max_value: num(param.max_value), target_value: num(param.target_value), sort_order: Number(param.sort_order) || 0 };
      const r = param.id ? await http.put(`/fabric-process/qc-params/${param.id}`, body) : await http.post('/fabric-process/qc-params', body);
      toast((r as any).message, 'success'); setParam(null); refresh();
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  if (q.isLoading) return <LoadingBlock />;
  return (
    <>
      {master && <div className="mb-3 flex justify-end"><Button onClick={() => setType({ code: '', name: '', output_state: 'FINISHED', changes_colour: false, allow_reprocess: true, allow_split: true, is_reprocess: false, requires_qc: false, sort_order: 0, is_active: true })}><Plus size={14} className="mr-1" /> New process type</Button></div>}
      <div className="space-y-3">
        {(q.data ?? []).map((t) => (
          <div key={t.id} className={`card overflow-hidden ${yes(t.is_active) ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2.5 text-xs">
              <span className="font-mono font-bold text-brand-700">{t.code}</span><span className="text-[13px] font-semibold">{t.name}</span>
              <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10.5px] font-bold text-purple-800">→ {t.output_state}</span>
              {yes(t.requires_qc) && <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10.5px] font-bold text-orange-800">QC required before posting</span>}
              {yes(t.is_reprocess) && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-bold text-slate-700">Reprocess</span>}
              {yes(t.changes_colour) && <span className="text-slate-500">changes colour</span>}
              {!yes(t.is_active) && <span className="text-red-600">inactive</span>}
              {master && <span className="ml-auto flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => setType({ ...t, changes_colour: yes(t.changes_colour), allow_reprocess: yes(t.allow_reprocess), allow_split: yes(t.allow_split), is_reprocess: yes(t.is_reprocess), requires_qc: yes(t.requires_qc), is_active: yes(t.is_active) })}><Pencil size={12} className="mr-1" /> Edit</Button>
                <Button size="sm" onClick={() => setParam({ process_code: t.code, param_name: '', uom: '', min_value: '', max_value: '', target_value: '', is_mandatory: true, sort_order: ((t.qc_params?.length ?? 0) + 1) * 10, is_active: true })}><Plus size={12} className="mr-1" /> QC parameter</Button>
              </span>}
            </div>
            {t.qc_params?.length ? (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>{['QC parameter', 'UOM', 'Min', 'Target', 'Max', 'Mandatory', 'Active', ''].map((h) => <th key={h} className="px-3 py-1.5 text-left">{h}</th>)}</tr></thead>
                <tbody>{t.qc_params.map((p: any) => (
                  <tr key={p.id} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{p.param_name}</td><td className="px-3 py-1.5">{p.uom || '—'}</td>
                    <td className="px-3 py-1.5">{p.min_value ?? '—'}</td><td className="px-3 py-1.5">{p.target_value ?? '—'}</td><td className="px-3 py-1.5">{p.max_value ?? '—'}</td>
                    <td className="px-3 py-1.5">{yes(p.is_mandatory) ? 'Yes' : 'No'}</td><td className="px-3 py-1.5">{yes(p.is_active) ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-1.5 text-right">{master && <button className="p-1 text-slate-400 hover:text-brand-700" title="Edit" onClick={() => setParam({ ...p, uom: p.uom ?? '', min_value: p.min_value ?? '', max_value: p.max_value ?? '', target_value: p.target_value ?? '', is_mandatory: yes(p.is_mandatory), is_active: yes(p.is_active) })}><Pencil size={13} /></button>}</td></tr>
                ))}</tbody>
              </table>
            ) : <div className="px-4 py-2 text-[11.5px] text-slate-400">No QC parameters</div>}
          </div>
        ))}
      </div>
      {type && (
        <Modal open onClose={() => setType(null)} title={type.id ? `Edit ${type.code}` : 'New process type'} size="md"
          footer={<><Button variant="secondary" onClick={() => setType(null)}>Cancel</Button><Button loading={busy} onClick={saveType}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Code *" value={type.code} disabled={!!type.id} onChange={(e) => setType({ ...type, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
            <Input label="Name *" value={type.name} onChange={(e) => setType({ ...type, name: e.target.value })} />
            <Select label="Output state *" value={type.output_state} onChange={(e) => setType({ ...type, output_state: e.target.value })} options={STATES.map((x) => ({ value: x, label: x }))} />
            <Input label="Sort order" type="number" value={type.sort_order} onChange={(e) => setType({ ...type, sort_order: e.target.value })} />
            <Checkbox label="GRN requires QC before posting" checked={type.requires_qc} onChange={(v) => setType({ ...type, requires_qc: v })} />
            <Checkbox label="Changes colour" checked={type.changes_colour} onChange={(v) => setType({ ...type, changes_colour: v })} />
            <Checkbox label="Allow reprocess" checked={type.allow_reprocess} onChange={(v) => setType({ ...type, allow_reprocess: v })} />
            <Checkbox label="Allow roll split" checked={type.allow_split} onChange={(v) => setType({ ...type, allow_split: v })} />
            <Checkbox label="Is a reprocess type" checked={type.is_reprocess} onChange={(v) => setType({ ...type, is_reprocess: v })} />
            <Checkbox label="Active" checked={type.is_active} onChange={(v) => setType({ ...type, is_active: v })} />
          </div>
        </Modal>
      )}
      {param && (
        <Modal open onClose={() => setParam(null)} title={`${param.id ? 'Edit' : 'New'} QC parameter — ${param.process_code}`} size="md"
          footer={<><Button variant="secondary" onClick={() => setParam(null)}>Cancel</Button><Button loading={busy} onClick={saveParam}>Save</Button></>}>
          <div className="grid grid-cols-3 gap-3">
            <Input label="Parameter *" className="col-span-2" value={param.param_name} onChange={(e) => setParam({ ...param, param_name: e.target.value })} />
            <Input label="UOM" value={param.uom} onChange={(e) => setParam({ ...param, uom: e.target.value })} />
            <Input label="Min" type="number" step="0.001" value={param.min_value} onChange={(e) => setParam({ ...param, min_value: e.target.value })} />
            <Input label="Target" type="number" step="0.001" value={param.target_value} onChange={(e) => setParam({ ...param, target_value: e.target.value })} />
            <Input label="Max" type="number" step="0.001" value={param.max_value} onChange={(e) => setParam({ ...param, max_value: e.target.value })} />
            <Input label="Sort order" type="number" value={param.sort_order} onChange={(e) => setParam({ ...param, sort_order: e.target.value })} />
            <Checkbox label="Mandatory" checked={param.is_mandatory} onChange={(v) => setParam({ ...param, is_mandatory: v })} />
            <Checkbox label="Active" checked={param.is_active} onChange={(v) => setParam({ ...param, is_active: v })} />
          </div>
          <p className="mt-3 text-[11.5px] text-slate-500">A value outside min – max fails the parameter; a roll with a failed parameter cannot be accepted (hold or reject it).</p>
        </Modal>
      )}
    </>
  );
}

function ReasonsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const master = can('FABRIC_PROCESS.MASTER');
  const q = useQuery({ queryKey: ['fabric-process', 'reasons', 'all'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/reasons/all')).data ?? [] });
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...r, default_billing: r.default_billing || null };
      const x = r.id ? await http.put(`/fabric-process/reasons/${r.id}`, body) : await http.post('/fabric-process/reasons', body);
      toast((x as any).message, 'success'); setR(null); void qc.invalidateQueries({ queryKey: ['fabric-process', 'reasons'] });
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  if (q.isLoading) return <LoadingBlock />;
  return (
    <>
      {master && <div className="mb-3 flex justify-end"><Button onClick={() => setR({ code: '', reason: '', kind: 'BOTH', default_billing: '', is_active: true })}><Plus size={14} className="mr-1" /> New reason</Button></div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Code', 'Reason', 'Used for', 'Default billing', 'Active', ''].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
          <tbody>{(q.data ?? []).map((x) => (
            <tr key={x.id} className="border-t border-slate-100"><td className="px-3 py-1.5 font-mono">{x.code}</td><td className="px-3 py-1.5 font-semibold">{x.reason}</td><td className="px-3 py-1.5">{x.kind}</td>
              <td className="px-3 py-1.5">{x.default_billing || '—'}</td><td className="px-3 py-1.5">{yes(x.is_active) ? 'Yes' : 'No'}</td>
              <td className="px-3 py-1.5 text-right">{master && <button className="p-1 text-slate-400 hover:text-brand-700" onClick={() => setR({ ...x, default_billing: x.default_billing ?? '', is_active: yes(x.is_active) })}><Pencil size={13} /></button>}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {r && (
        <Modal open onClose={() => setR(null)} title={r.id ? `Edit ${r.code}` : 'New reason'} size="md"
          footer={<><Button variant="secondary" onClick={() => setR(null)}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Code *" value={r.code} disabled={!!r.id} onChange={(e) => setR({ ...r, code: e.target.value.toUpperCase() })} />
            <Select label="Used for *" value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value })} options={[{ value: 'RETURN', label: 'Return / reject' }, { value: 'BILLING', label: 'Reprocess billing' }, { value: 'BOTH', label: 'Both' }]} />
            <Input label="Reason *" className="col-span-2" value={r.reason} onChange={(e) => setR({ ...r, reason: e.target.value })} />
            <Select label="Default billing" value={r.default_billing} placeholder="—" onChange={(e) => setR({ ...r, default_billing: e.target.value })} options={BILLING.map((b) => ({ value: b, label: b.replace('_', ' ') }))} />
            <Checkbox label="Active" checked={r.is_active} onChange={(v) => setR({ ...r, is_active: v })} />
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Fabric Process — Reports (doc §18 / §34): process unit-wise pending, reject / return,
 * reprocess pending (incl. billable not yet billed), reprocess by billing reason, process loss.
 */
const REPORTS: { key: string; label: string; cols: [string, string, ('kg' | 'amt' | 'date' | 'pct' | 'status')?][] }[] = [
  { key: 'unit-pending', label: 'Process unit-wise pending', cols: [['vendor', 'Process unit'], ['sub_process', 'Process'], ['open_dcs', 'Open DCs'], ['dcs', 'DC nos'], ['oldest_dc_date', 'Oldest DC', 'date'], ['oldest_days', 'Days'], ['outward_kg', 'Outward KG', 'kg'], ['received_kg', 'Received KG', 'kg'], ['pending_kg', 'Pending KG', 'kg']] },
  { key: 'reject-return', label: 'Reject / return', cols: [['kind', 'Type'], ['doc_date', 'Date', 'date'], ['doc_no', 'Doc no'], ['fpo_no', 'DC'], ['vendor', 'Process unit'], ['sub_process', 'Process'], ['io_no', 'Job'], ['input_roll', 'Roll'], ['output_roll', 'Output roll'], ['qty_kg', 'KG', 'kg'], ['reason', 'Reason']] },
  { key: 'reprocess-pending', label: 'Reprocess pending', cols: [['reprocess_no', 'Reprocess'], ['reprocess_date', 'Date', 'date'], ['days', 'Days'], ['sub_process', 'Process'], ['vendor', 'Process unit'], ['fpo_no', 'DC'], ['status', 'Status', 'status'], ['total_kg', 'KG', 'kg'], ['pending_kg', 'Not received KG', 'kg'], ['billing_type', 'Billing'], ['billing_status', 'Billing status', 'status'], ['bill_amount', 'Bill amount', 'amt'], ['pending_for', 'Pending for']] },
  { key: 'billing-reasons', label: 'Reprocess by billing reason', cols: [['reason', 'Reason'], ['billing_type', 'Billing'], ['vendor', 'Process unit'], ['entries', 'Entries'], ['kg', 'KG', 'kg'], ['bill_amount', 'Billable amount', 'amt'], ['internal_cost', 'Internal cost', 'amt']] },
  { key: 'process-loss', label: 'Process loss', cols: [['fpo_no', 'DC'], ['fpo_date', 'Date', 'date'], ['sub_process', 'Process'], ['vendor', 'Process unit'], ['io_no', 'Job'], ['outward_kg', 'Outward KG', 'kg'], ['good_kg', 'Good KG', 'kg'], ['reject_kg', 'Reject KG', 'kg'], ['loss_kg', 'Loss KG', 'kg'], ['reject_pct', 'Reject %', 'pct'], ['loss_pct', 'Loss %', 'pct']] },
];
export function FabricProcessReportsPage() {
  const [tab, setTab] = useState(REPORTS[0].key);
  const [f, setF] = useState({ from: '', to: '', vendor_id: '', sub_process: '' });
  const [applied, setApplied] = useState(f);
  const suppliers = useLookup('suppliers');
  const types = useProcessTypes();
  const rep = REPORTS.find((r) => r.key === tab)!;
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v) as [string, string][]).toString();
  const q = useQuery({ queryKey: ['fabric-process', 'report', tab, qs], queryFn: async () => (await http.get<{ data: any[] }>(`/fabric-process/reports/${tab}${qs ? `?${qs}` : ''}`)).data ?? [] });
  const rows = q.data ?? [];
  const fmt = (v: any, t?: string) => (t === 'kg' ? kg(v) : t === 'amt' ? fmtDecimal(Number(v ?? 0), 2) : t === 'date' ? fmtDate(v) : t === 'pct' ? `${fmtDecimal(Number(v ?? 0), 2)}%` : v ?? '—');
  const sumCols = rep.cols.filter((c) => c[2] === 'kg' || c[2] === 'amt');
  const total = (k: string) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const csv = () => {
    const lines = [rep.cols.map((c) => c[1]).join(','), ...rows.map((r) => rep.cols.map((c) => `"${String(c[2] === 'date' ? fmtDate(r[c[0]]) : r[c[0]] ?? '').replace(/"/g, '""')}"`).join(','))];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `${tab}.csv`; a.click();
  };
  return (
    <div>
      <FpTitle no={9} title="Fabric Process Reports" sub="Pending at process units, rejects / returns, reprocess, billing reasons, process loss" />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={REPORTS.map((r) => ({ key: r.key, label: r.label }))} active={tab} onChange={setTab} /></div>
      <div className="card mb-3 flex flex-wrap items-end gap-2 p-4">
        <Input label="From" type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Process unit" className="w-64" value={f.vendor_id} placeholder="All" onChange={(e) => setF({ ...f, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Select label="Process" className="w-48" value={f.sub_process} placeholder="All" onChange={(e) => setF({ ...f, sub_process: e.target.value })} options={(types.data ?? []).map((t) => ({ value: t.code, label: t.name }))} />
        <Button onClick={() => setApplied(f)}><Search size={14} className="mr-1" /> Show</Button>
        <Button variant="secondary" disabled={!rows.length} onClick={csv}><Download size={14} className="mr-1" /> Excel (CSV)</Button>
      </div>
      <div className="card overflow-x-auto">
        {q.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{rep.cols.map((c) => <th key={c[0]} className={`px-3 py-2 ${c[2] && c[2] !== 'date' && c[2] !== 'status' ? 'text-right' : 'text-left'}`}>{c[1]}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">{rep.cols.map((c) => <td key={c[0]} className={`px-3 py-1.5 ${c[2] && c[2] !== 'date' && c[2] !== 'status' ? 'text-right tabular-nums' : ''}`}>{c[2] === 'status' ? <FpStatus value={r[c[0]]} /> : fmt(r[c[0]], c[2])}</td>)}</tr>
              ))}
              {!rows.length && <tr><td colSpan={rep.cols.length} className="px-3 py-10 text-center text-slate-400">Nothing to show</td></tr>}
            </tbody>
            {rows.length > 0 && sumCols.length > 0 && (
              <tfoot className="bg-slate-100 font-bold"><tr>{rep.cols.map((c, i) => <td key={c[0]} className={`px-3 py-2 ${c[2] === 'kg' || c[2] === 'amt' ? 'text-right' : ''}`}>{c[2] === 'kg' || c[2] === 'amt' ? fmt(total(c[0]), c[2]) : i === 0 ? 'Total' : ''}</td>)}</tr></tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}
