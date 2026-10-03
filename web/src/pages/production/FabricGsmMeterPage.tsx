import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Ruler, BarChart3, Plus, CheckCircle2, Save } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { PageHeader, Tabs, Input, Select, Button, Modal, LoadingBlock } from '../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { FORM_LABEL, fmtPct, pctCls, type DiaRule } from '../../lib/fabricCalc';

/**
 * Fabric GSM & Meter (client doc 03-Oct-2026): what the ERP calculates (KG → meter from GSM + Dia/width)
 * next to what was actually received (measured meter / QC GSM), the Dia → width rules, and a calculator.
 * The "suggested factor" per fabric / Dia is what the measured rolls imply — use it to tune the rule so the
 * auto meter comes close to the real one.
 */
export default function FabricGsmMeterPage() {
  const [tab, setTab] = useState('variance');
  return (
    <div className="space-y-4">
      <PageHeader title="Fabric GSM & Meter" subtitle="Calculated vs actual meter, target vs actual GSM per roll · Dia/width rules · calculator" />
      <Tabs tabs={[{ key: 'variance', label: 'Variance report' }, { key: 'rules', label: 'Dia / width rules' }, { key: 'calc', label: 'Calculator' }]} active={tab} onChange={setTab} />
      {tab === 'variance' && <VarianceTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'calc' && <CalcTab />}
    </div>
  );
}

function VarianceTab() {
  const [f, setF] = useState({ from: '', to: '', fabric_id: '', measured: '1', flagged: '' });
  const fabrics = useLookup('fabrics');
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
  const q = useQuery({ queryKey: ['gsm-variance', qs.toString()], queryFn: async () => http.get<{ data: any[]; summary: any[] }>(`/fabric-rolls/gsm-variance?${qs}`) });
  const rows = q.data?.data ?? []; const sum = q.data?.summary ?? [];
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Fabric" className="w-72" placeholder="All fabrics" value={f.fabric_id} onChange={(e) => setF({ ...f, fabric_id: e.target.value })} options={toOptions(fabrics.data)} />
        <label className="flex items-center gap-1.5 pb-2 text-xs"><input type="checkbox" checked={f.measured === '1'} onChange={(e) => setF({ ...f, measured: e.target.checked ? '1' : '' })} id="gv-measured" /> Measured rolls only</label>
        <label className="flex items-center gap-1.5 pb-2 text-xs"><input type="checkbox" checked={f.flagged === '1'} onChange={(e) => setF({ ...f, flagged: e.target.checked ? '1' : '' })} id="gv-flagged" /> Outside tolerance only</label>
      </div>
      {q.isLoading ? <LoadingBlock /> : (
        <>
          <div className="card overflow-x-auto">
            <div className="px-4 pt-3 text-[13px] font-semibold text-slate-800">By fabric / Dia — how far the auto meter is from the real one</div>
            <table className="mt-2 w-full text-xs" id="gv-summary">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Fabric', 'Form', 'Dia (inch)', 'Rolls', 'Measured', 'KG', 'Meter variance', 'Avg GSM variance', 'Rule factor', 'Suggested factor', 'Out of tolerance'].map((h) => <th key={h} className={`px-3 py-2 ${/Rolls|Measured|KG|variance|factor|tolerance/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {sum.map((s, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-medium">{s.fabric_name ?? '—'}</td><td className="px-3 py-1.5">{s.fabric_form ? FORM_LABEL[s.fabric_form as keyof typeof FORM_LABEL] : '—'}</td>
                    <td className="px-3 py-1.5">{s.dia_inch ?? '—'}</td><td className="px-3 py-1.5 text-right">{s.rolls}</td><td className="px-3 py-1.5 text-right">{s.measured_rolls}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDecimal(s.kg, 3)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${pctCls(s.meter_var_pct)}`}>{fmtPct(s.meter_var_pct)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${pctCls(s.avg_gsm_var_pct)}`}>{fmtPct(s.avg_gsm_var_pct)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtDecimal(s.rule_factor, 4)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-sky-800" title="Width the measured rolls actually have ÷ Dia — set this as the rule factor to make the auto meter match">{s.suggested_factor != null ? fmtDecimal(s.suggested_factor, 4) : '—'}</td>
                    <td className={`px-3 py-1.5 text-right ${s.flagged ? 'font-semibold text-orange-700' : 'text-slate-400'}`}>{s.flagged}</td>
                  </tr>
                ))}
                {!sum.length && <tr><td colSpan={11} className="px-3 py-6 text-center text-slate-400">No calculated rolls yet — rolls received from now on carry the calculation</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <div className="px-4 pt-3 text-[13px] font-semibold text-slate-800">Rolls ({rows.length})</div>
            <table className="mt-2 w-full text-xs" id="gv-rolls">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Roll', 'GRN', 'Date', 'Job', 'Fabric', 'Dia', 'Width M', 'KG', 'Target GSM', 'Actual GSM', 'GSM var', 'Calc Mtr', 'Actual Mtr', 'Mtr var', 'QC'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|GSM|Mtr|var|Width/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t border-slate-100 ${r.gsm_flag ? 'bg-orange-50/60' : ''}`}>
                    <td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1 font-mono">{r.grn_no}</td><td className="px-2 py-1">{fmtDate(r.grn_date)}</td>
                    <td className="px-2 py-1">{r.io_no ?? '—'}</td><td className="px-2 py-1">{r.fabric_name}</td><td className="px-2 py-1">{r.dia ?? '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.width_m ? Number(r.width_m).toFixed(3) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtDecimal(r.weight_kg, 3)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.target_gsm ? Number(r.target_gsm).toFixed(1) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.actual_gsm ? Number(r.actual_gsm).toFixed(1) : '—'}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctCls(r.gsm_var_pct != null ? Number(r.gsm_var_pct) : null)}`}>{fmtPct(r.gsm_var_pct != null ? Number(r.gsm_var_pct) : null)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-sky-800">{r.calc_meters ? Number(r.calc_meters).toFixed(2) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.actual_meters ? Number(r.actual_meters).toFixed(2) : '—'}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pctCls(r.meter_var_pct != null ? Number(r.meter_var_pct) : null)}`}>{fmtPct(r.meter_var_pct != null ? Number(r.meter_var_pct) : null)}</td>
                    <td className="px-2 py-1">{r.qc_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const blankRule = () => ({ rule_code: '', fabric_form: 'TUBULAR', dia_definition: '', formula_type: 'FACTOR', factor: 2 as number | string, effective_from: today(), effective_to: '', is_active: true, remarks: '' });
function RulesTab() {
  const toast = useToast(); const qc = useQueryClient(); const { can } = useAuth();
  const q = useQuery({ queryKey: ['dia-width-rules'], queryFn: async () => (await http.get<{ data: (DiaRule & any)[] }>('/dia-width-rules')).data ?? [] });
  const [edit, setEdit] = useState<null | { id: number | null; v: ReturnType<typeof blankRule>; approved: boolean }>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return; setBusy(true);
    try {
      const body = { ...edit.v, factor: Number(edit.v.factor) || 1, effective_to: edit.v.effective_to || null };
      const r = edit.id ? await http.put<any>(`/dia-width-rules/${edit.id}`, body) : await http.post<any>('/dia-width-rules', body);
      toast(r.message ?? 'Saved', 'success'); setEdit(null); void qc.invalidateQueries({ queryKey: ['dia-width-rules'] });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Save failed', 'error'); } finally { setBusy(false); }
  };
  const approve = async (id: number) => {
    try { const r = await http.post<any>(`/dia-width-rules/${id}/approve`, {}); toast(r.message, 'success'); void qc.invalidateQueries({ queryKey: ['dia-width-rules'] }); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Approve failed', 'error'); }
  };
  const k = (r: any) => (r.formula_type === 'DIRECT' ? 1 : r.formula_type === 'CIRCUMFERENCE' ? Math.PI : Number(r.factor));
  return (
    <div className="card overflow-x-auto">
      <div className="flex items-center justify-between px-4 pt-3">
        <p className="text-xs text-slate-600"><Ruler size={13} className="mr-1 inline" />Width M = Dia (inch) × factor × 0.0254. The newest approved rule effective on the roll's date is used; a new factor = a new rule with a later start date.</p>
        {can('MATERIAL.CREATE') && <Button size="sm" onClick={() => setEdit({ id: null, v: blankRule(), approved: false })} id="btn-new-rule"><Plus size={13} className="mr-1" /> New rule</Button>}
      </div>
      {q.isLoading ? <LoadingBlock /> : (
        <table className="mt-2 w-full text-xs" id="dwr-table">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Rule', 'Form', 'What "Dia" means', 'Formula', 'Factor', 'Effective', 'Status', 'In use', ''].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
          <tbody>{(q.data ?? []).map((r: any) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-3 py-1.5 font-mono font-semibold">{r.rule_code}</td><td className="px-3 py-1.5">{FORM_LABEL[r.fabric_form as keyof typeof FORM_LABEL]}</td>
              <td className="px-3 py-1.5">{r.dia_definition}</td><td className="px-3 py-1.5">{r.formula_type}</td><td className="px-3 py-1.5 tabular-nums">{fmtDecimal(k(r), 4)}</td>
              <td className="px-3 py-1.5">{fmtDate(r.effective_from)}{r.effective_to ? ` – ${fmtDate(r.effective_to)}` : ' →'}</td>
              <td className="px-3 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.approval_status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{r.approval_status}</span>{!r.is_active ? <span className="ml-1 text-slate-400">inactive</span> : null}</td>
              <td className="px-3 py-1.5">{r.in_use ? <CheckCircle2 size={14} className="text-emerald-600" /> : ''}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap">
                {can('MATERIAL.UPDATE') && <button className="mr-2 text-sky-700 hover:underline" onClick={() => setEdit({ id: r.id, approved: r.approval_status === 'APPROVED', v: { rule_code: r.rule_code, fabric_form: r.fabric_form, dia_definition: r.dia_definition, formula_type: r.formula_type, factor: Number(r.factor), effective_from: String(r.effective_from).slice(0, 10), effective_to: r.effective_to ? String(r.effective_to).slice(0, 10) : '', is_active: !!r.is_active, remarks: r.remarks ?? '' } })}>Edit</button>}
                {r.approval_status !== 'APPROVED' && can('MATERIAL.UPDATE') && <button className="text-emerald-700 hover:underline" onClick={() => void approve(r.id)} id={`btn-approve-rule-${r.id}`}>Approve</button>}
              </td>
            </tr>))}</tbody>
        </table>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit rule ${edit.v.rule_code}` : 'New Dia / width rule'} size="md"
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={busy} onClick={save} id="btn-save-rule"><Save size={14} className="mr-1" /> Save</Button></>}>
          {edit.approved && <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11.5px] text-amber-900">Approved rule: only the end date, active flag and notes can change. For a new factor add a new rule.</p>}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Rule code *" value={edit.v.rule_code} disabled={edit.approved} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, rule_code: e.target.value } })} id="rule-code" />
            <Select label="Fabric form *" value={edit.v.fabric_form} disabled={edit.approved} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, fabric_form: e.target.value } })} options={[{ value: 'TUBULAR', label: 'Tubular' }, { value: 'OPEN_WIDTH', label: 'Open width' }]} id="rule-form" />
            <Input label='What "Dia" means *' className="col-span-2" value={edit.v.dia_definition} placeholder="e.g. Finished tubular (flat) Dia" onChange={(e) => setEdit({ ...edit, v: { ...edit.v, dia_definition: e.target.value } })} id="rule-def" />
            <Select label="Formula *" value={edit.v.formula_type} disabled={edit.approved} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, formula_type: e.target.value } })} id="rule-formula"
              options={[{ value: 'FACTOR', label: 'FACTOR — width = Dia × factor' }, { value: 'DIRECT', label: 'DIRECT — width = Dia' }, { value: 'CIRCUMFERENCE', label: 'CIRCUMFERENCE — width = Dia × π' }]} />
            <Input label="Factor" type="number" step="0.0001" value={edit.v.factor} disabled={edit.approved || edit.v.formula_type !== 'FACTOR'} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, factor: e.target.value } })} id="rule-factor" />
            <Input label="Effective from *" type="date" value={edit.v.effective_from} disabled={edit.approved} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, effective_from: e.target.value } })} id="rule-from" />
            <Input label="Effective to" type="date" value={edit.v.effective_to} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, effective_to: e.target.value } })} id="rule-to" />
            <Input label="Notes" className="col-span-2" value={edit.v.remarks} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, remarks: e.target.value } })} />
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={edit.v.is_active} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, is_active: e.target.checked } })} /> Active</label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CalcTab() {
  const toast = useToast();
  const [v, setV] = useState({ weight_kg: '', meters: '', gsm: '', dia: '', fabric_form: 'TUBULAR', width_m: '' });
  const [out, setOut] = useState<any>(null);
  const run = async () => {
    try {
      const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : (['dia', 'fabric_form'].includes(k) ? x : Number(x))]));
      setOut((await http.post<{ data: any }>('/fabric-calc/solve', body)).data);
    } catch (e) { setOut(null); toast(e instanceof ApiError ? e.message : 'Could not calculate', 'error'); }
  };
  return (
    <div className="card max-w-3xl space-y-3 p-4">
      <p className="text-xs text-slate-600"><Calculator size={13} className="mr-1 inline" />Fill three of KG, meter, GSM and width (or Dia + form) — the fourth is calculated with the approved rule.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Input label="Roll KG" type="number" value={v.weight_kg} onChange={(e) => setV({ ...v, weight_kg: e.target.value })} id="calc-kg" />
        <Input label="Meter" type="number" value={v.meters} onChange={(e) => setV({ ...v, meters: e.target.value })} id="calc-m" />
        <Input label="GSM" type="number" value={v.gsm} onChange={(e) => setV({ ...v, gsm: e.target.value })} id="calc-gsm" />
        <Input label="Dia (inch)" value={v.dia} onChange={(e) => setV({ ...v, dia: e.target.value, width_m: '' })} id="calc-dia" />
        <Select label="Form" value={v.fabric_form} onChange={(e) => setV({ ...v, fabric_form: e.target.value })} options={[{ value: 'TUBULAR', label: 'Tubular' }, { value: 'OPEN_WIDTH', label: 'Open width' }]} id="calc-form" />
        <Input label="or Width M" type="number" value={v.width_m} onChange={(e) => setV({ ...v, width_m: e.target.value, dia: '' })} id="calc-w" />
      </div>
      <Button onClick={run} id="btn-calc"><BarChart3 size={14} className="mr-1" /> Calculate</Button>
      {out && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900" id="calc-out">
          {out.solved === 'meters' && <>Meter = <b>{fmtDecimal(out.meters, 2)}</b> m</>}
          {out.solved === 'weight_kg' && <>KG = <b>{fmtDecimal(out.weight_kg, 3)}</b></>}
          {out.solved === 'gsm' && <>GSM = <b>{fmtDecimal(out.gsm, 1)}</b></>}
          {out.solved === 'width_m' && <>Width = <b>{fmtDecimal(out.width_m, 4)}</b> m</>}
          {out.width_m && out.solved !== 'width_m' ? <span className="ml-3 text-xs">width {fmtDecimal(out.width_m, 4)} m{out.rule_code ? ` · rule ${out.rule_code}` : ''}</span> : null}
        </div>
      )}
    </div>
  );
}
