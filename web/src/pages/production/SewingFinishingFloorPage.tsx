import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScanLine } from 'lucide-react';
import { Card, Badge, Button, Input, Select, DataTable, StatusBadge, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/**
 * Scan-driven sewing / finishing / final QC floor (doc §15, §20).
 * Scan a bundle → see its balance at every stage → post the movement.
 * The server rejects anything beyond the previous stage's good PCS.
 */

type Tab = 'SEWING_IN' | 'SEWING_OUT' | 'FINISHING_IN' | 'FINISHING_OUT' | 'FINAL_QC';
const TABS: { key: Tab; label: string }[] = [
  { key: 'SEWING_IN', label: 'Sewing input' },
  { key: 'SEWING_OUT', label: 'Sewing output' },
  { key: 'FINISHING_IN', label: 'Finishing input' },
  { key: 'FINISHING_OUT', label: 'Finishing output' },
  { key: 'FINAL_QC', label: 'Final QC' },
];
const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;

export function SewingFinishingFloorPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('SEWING_IN');
  const [code, setCode] = useState('');
  const [bundle, setBundle] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<any>({});
  const [register, setRegister] = useState<any[]>([]);
  const [regLoading, setRegLoading] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const loadRegister = () => {
    setRegLoading(true);
    const url = tab.startsWith('SEWING') ? '/sewing/inputs' : tab.startsWith('FINISHING') ? '/finishing/inputs' : '/final-qc';
    api.get(url).then((r) => setRegister(r.data.data || [])).catch(() => setRegister([])).finally(() => setRegLoading(false));
  };
  useEffect(loadRegister, [tab]);

  const defaults = (b: any, t: Tab) => {
    const a = b?.avail ?? {};
    const openSew = (b?.sewing ?? []).find((s: any) => s.status !== 'CANCELLED' && num(s.input_qty) - num(s.good_qty) - num(s.reject_qty) > 0);
    const openFin = (b?.finishing ?? []).find((s: any) => s.status !== 'CANCELLED' && num(s.input_qty) - num(s.good_qty) - num(s.reject_qty) > 0);
    const base = { date: today(), line_name: form.line_name ?? 'LINE-01', work_center: form.work_center ?? '', operator_name: form.operator_name ?? '', inspector_name: form.inspector_name ?? '', remarks: '' };
    if (t === 'SEWING_IN') return { ...base, qty: a.cut ?? 0 };
    if (t === 'SEWING_OUT') return { ...base, input_id: openSew?.id ?? '', good: openSew ? num(openSew.input_qty) - num(openSew.good_qty) - num(openSew.reject_qty) : 0, reject: 0, rework: 0 };
    if (t === 'FINISHING_IN') return { ...base, qty: a.sewn ?? 0, line_name: form.fin_line ?? 'FIN-01' };
    if (t === 'FINISHING_OUT') return { ...base, input_id: openFin?.id ?? '', good: openFin ? num(openFin.input_qty) - num(openFin.good_qty) - num(openFin.reject_qty) : 0, reject: 0, rework: 0 };
    return { ...base, inspected: a.qc ?? 0, passed: a.qc ?? 0, reject: 0, rework: 0, hold: 0 };
  };

  const scan = async (c: string, t: Tab = tab) => {
    const v = c.trim();
    if (!v) return;
    setScanning(true);
    try {
      const r = await api.get(`/bundles/scan/${encodeURIComponent(v)}`, { params: { context: t } });
      setBundle(r.data.data);
      setForm(defaults(r.data.data, t));
    } catch (e) {
      setBundle(null);
      toast(errMsg(e), 'error');
    } finally {
      setScanning(false);
      scanRef.current?.select();
    }
  };

  useEffect(() => { if (bundle) setForm(defaults(bundle, tab)); }, [tab]);

  const post = async () => {
    if (!bundle) return;
    setSaving(true);
    try {
      let msg = '';
      if (tab === 'SEWING_IN') {
        await api.post('/sewing/input', { bundle_id: bundle.id, input_date: form.date, input_qty: Number(form.qty), line_name: form.line_name, work_center: form.work_center || null, operator_name: form.operator_name || null });
        msg = `${bundle.bundle_no}: ${form.qty} PCS issued to ${form.line_name}`;
      } else if (tab === 'SEWING_OUT') {
        if (!form.input_id) throw new Error('No open sewing input for this bundle');
        await api.post('/sewing/output', { sewing_input_id: Number(form.input_id), output_date: form.date, output_qty: Number(form.good), reject_qty: Number(form.reject), rework_qty: Number(form.rework) });
        msg = `${bundle.bundle_no}: sewing output ${form.good} good / ${form.reject} reject PCS`;
      } else if (tab === 'FINISHING_IN') {
        await api.post('/finishing/input', { bundle_id: bundle.id, input_date: form.date, input_qty: Number(form.qty), line_name: form.line_name || null, work_center: form.work_center || null });
        msg = `${bundle.bundle_no}: ${form.qty} PCS into finishing`;
      } else if (tab === 'FINISHING_OUT') {
        if (!form.input_id) throw new Error('No open finishing input for this bundle');
        await api.post('/finishing/output', { finishing_input_id: Number(form.input_id), output_date: form.date, output_qty: Number(form.good), reject_qty: Number(form.reject), rework_qty: Number(form.rework) });
        msg = `${bundle.bundle_no}: finished ${form.good} good / ${form.reject} reject PCS`;
      } else {
        await api.post('/final-qc', { bundle_id: bundle.id, qc_date: form.date, inspected_qty: Number(form.inspected), passed_qty: Number(form.passed), reject_qty: Number(form.reject), rework_qty: Number(form.rework), hold_qty: Number(form.hold), inspector_name: form.inspector_name || null });
        msg = `${bundle.bundle_no}: QC ${form.passed} passed / ${form.reject} rejected PCS`;
      }
      toast(msg);
      await scan(bundle.barcode ?? bundle.bundle_no);
      loadRegister();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const a = bundle?.avail ?? {};
  const openInputs = (list: any[]) => (list ?? []).filter((s) => s.status !== 'CANCELLED' && num(s.input_qty) - num(s.good_qty) - num(s.reject_qty) > 0);
  const available = tab === 'SEWING_IN' ? a.cut : tab === 'FINISHING_IN' ? a.sewn : tab === 'FINAL_QC' ? a.qc : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Sewing &amp; Finishing Floor</h1>
        <p className="text-sm text-slate-500">Scan a bundle, check its balance, post the movement — quantities can never exceed the previous stage</p>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={(k) => setTab(k as Tab)} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <form onSubmit={(e) => { e.preventDefault(); scan(code); }} className="flex gap-2 border-b border-slate-100 p-4">
            <div className="relative flex-1">
              <ScanLine size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-600" />
              <input ref={scanRef} autoFocus value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="Scan bundle barcode (or type bundle no) and press Enter"
                className="input h-11 pl-10 font-mono text-base" />
            </div>
            <Button type="submit" loading={scanning}>Scan</Button>
          </form>

          {!bundle && <p className="p-10 text-center text-sm text-slate-400">Scan a bundle to begin.</p>}
          {bundle && (
            <div className="p-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-lg font-bold text-slate-900">{bundle.bundle_no}</p>
                  <p className="text-xs text-slate-500">
                    {bundle.style_code} · {bundle.color_name} · Size {bundle.size_code} · {bundle.part_name ?? ''} · IO {bundle.io_no ?? '—'}
                  </p>
                  <p className="text-xs text-slate-400">
                    Cut order {bundle.plan_no ?? '—'} · Lay {bundle.lay_no ?? '—'} · Barcode {bundle.barcode}
                  </p>
                </div>
                <div className="text-right">
                  <StatusBadge value={bundle.status} />
                  <p className="mt-1 text-xs text-slate-500">Bundle qty <b>{fmtNumber(bundle.qty)} PCS</b></p>
                  <Link to={`/production/traceability?bundle=${encodeURIComponent(bundle.barcode ?? bundle.bundle_no)}`} className="text-xs text-brand-700 hover:underline">Full trace →</Link>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
                <Bal label="At cutting" v={a.cut} hi={tab === 'SEWING_IN'} />
                <Bal label="On sewing line" v={a.sewing_wip} hi={tab === 'SEWING_OUT'} />
                <Bal label="Sewn, to finishing" v={a.sewn} hi={tab === 'FINISHING_IN'} />
                <Bal label="In finishing" v={a.finishing_wip} hi={tab === 'FINISHING_OUT'} />
                <Bal label="Awaiting QC" v={a.qc} hi={tab === 'FINAL_QC'} />
                <Bal label="Ready to pack" v={a.pack} />
              </div>
              {(num(a.out_cut) + num(a.out_sewn) + num(a.out_pack) > 0 || num(a.rejected) > 0 || num(a.packed) > 0) && (
                <p className="text-xs text-slate-500">
                  {num(a.out_cut) + num(a.out_sewn) + num(a.out_pack) > 0 && <>Out on job-work DC: <b>{num(a.out_cut) + num(a.out_sewn) + num(a.out_pack)} PCS</b> · </>}
                  Rejected / short: <b>{num(a.rejected)} PCS</b> · Packed: <b>{num(a.packed)} PCS</b>
                </p>
              )}

              {/* Action form */}
              <div className="rounded-xl border border-brand-100 bg-brand-50/30 p-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Input label="Date" type="date" value={form.date ?? ''} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                  {(tab === 'SEWING_IN' || tab === 'FINISHING_IN') && <>
                    <Input label={`Qty (PCS) — max ${available ?? 0}`} type="number" min={1} max={available ?? 0} value={form.qty ?? ''}
                      onChange={(e) => setForm({ ...form, qty: e.target.value })} />
                    <Input label={tab === 'SEWING_IN' ? 'Sewing line' : 'Finishing line / table'} value={form.line_name ?? ''}
                      onChange={(e) => setForm({ ...form, line_name: e.target.value, ...(tab === 'FINISHING_IN' ? { fin_line: e.target.value } : {}) })} />
                    <Input label="Work centre" value={form.work_center ?? ''} onChange={(e) => setForm({ ...form, work_center: e.target.value })} />
                    {tab === 'SEWING_IN' && <Input label="Operator / supervisor" value={form.operator_name ?? ''} onChange={(e) => setForm({ ...form, operator_name: e.target.value })} />}
                  </>}
                  {(tab === 'SEWING_OUT' || tab === 'FINISHING_OUT') && (() => {
                    const list = openInputs(tab === 'SEWING_OUT' ? bundle.sewing : bundle.finishing);
                    const sel = list.find((s: any) => String(s.id) === String(form.input_id));
                    const pending = sel ? num(sel.input_qty) - num(sel.good_qty) - num(sel.reject_qty) : 0;
                    return <>
                      <Select label="Against input" value={form.input_id ?? ''} className="md:col-span-3"
                        onChange={(e) => {
                          const s = list.find((x: any) => String(x.id) === e.target.value);
                          setForm({ ...form, input_id: e.target.value, good: s ? num(s.input_qty) - num(s.good_qty) - num(s.reject_qty) : 0 });
                        }}
                        placeholder={list.length ? undefined : 'No open input for this bundle'}
                        options={list.map((s: any) => ({ value: s.id, label: `${s.input_no} · ${s.line_name ?? ''} · pending ${num(s.input_qty) - num(s.good_qty) - num(s.reject_qty)} of ${s.input_qty} PCS` }))} />
                      <Input label="Good (PCS)" type="number" min={0} value={form.good ?? 0} onChange={(e) => setForm({ ...form, good: e.target.value })} />
                      <Input label="Reject (PCS)" type="number" min={0} value={form.reject ?? 0} onChange={(e) => setForm({ ...form, reject: e.target.value })} />
                      <Input label="Rework (PCS)" type="number" min={0} value={form.rework ?? 0} onChange={(e) => setForm({ ...form, rework: e.target.value })}
                        hint="Rework PCS stay pending on the input" />
                      <p className="self-end pb-2 text-xs text-slate-500">Pending on input: <b>{pending} PCS</b></p>
                    </>;
                  })()}
                  {tab === 'FINAL_QC' && <>
                    <Input label={`Inspected (PCS) — max ${a.qc ?? 0}`} type="number" min={1} value={form.inspected ?? 0} onChange={(e) => setForm({ ...form, inspected: e.target.value })} />
                    <Input label="Passed (PCS)" type="number" min={0} value={form.passed ?? 0} onChange={(e) => setForm({ ...form, passed: e.target.value })} />
                    <Input label="Rejected (PCS)" type="number" min={0} value={form.reject ?? 0} onChange={(e) => setForm({ ...form, reject: e.target.value })} />
                    <Input label="Rework (PCS)" type="number" min={0} value={form.rework ?? 0} onChange={(e) => setForm({ ...form, rework: e.target.value })} />
                    <Input label="Hold (PCS)" type="number" min={0} value={form.hold ?? 0} onChange={(e) => setForm({ ...form, hold: e.target.value })} />
                    <Input label="Inspector" value={form.inspector_name ?? ''} onChange={(e) => setForm({ ...form, inspector_name: e.target.value })} />
                  </>}
                </div>
                <div className="mt-3 flex justify-end">
                  <Button loading={saving} onClick={post}>
                    {TABS.find((t) => t.key === tab)?.label} — post
                  </Button>
                </div>
              </div>

              {bundle.history?.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">Movement history</p>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-100">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {[...bundle.history].reverse().map((h: any) => (
                          <tr key={h.id} className="border-t border-slate-50">
                            <td className="px-2 py-1 text-slate-400">{fmtDate(h.moved_at)}</td>
                            <td className="px-2 py-1"><Badge tone="blue">{String(h.txn_type ?? h.to_stage).replace(/_/g, ' ')}</Badge></td>
                            <td className="px-2 py-1 text-right">{h.moved_qty} PCS</td>
                            <td className="px-2 py-1 text-slate-500">{h.good_qty != null ? `good ${h.good_qty}` : ''}{h.reject_qty ? ` · rej ${h.reject_qty}` : ''}</td>
                            <td className="px-2 py-1 text-slate-500">{h.location ?? h.destination ?? ''}</td>
                            <td className="px-2 py-1 text-slate-400">{h.moved_by_name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2" title={tab.startsWith('SEWING') ? 'Sewing inputs' : tab.startsWith('FINISHING') ? 'Finishing inputs' : 'Final QC register'}>
          <div className="max-h-[70vh] overflow-y-auto">
            <DataTable data={register} loading={regLoading} emptyTitle="Nothing yet"
              onRowClick={(r: any) => { const c = r.barcode ?? r.bundle_no; if (c) { setCode(c); scan(c); } }}
              columns={tab === 'FINAL_QC' ? [
                { key: 'qc_no', header: 'QC no', render: (r: any) => <span className="font-mono text-[11px]">{r.qc_no}</span> },
                { key: 'bundle_no', header: 'Bundle', render: (r: any) => <span className="font-mono text-[11px]">{r.bundle_no ?? '—'}</span> },
                { key: 'inspected_qty', header: 'Insp', align: 'right' as const },
                { key: 'passed_qty', header: 'Pass', align: 'right' as const },
                { key: 'reject_qty', header: 'Rej', align: 'right' as const },
                { key: 'qc_status', header: '', render: (r: any) => <StatusBadge value={r.qc_status} /> },
              ] : [
                { key: 'input_no', header: 'Input', render: (r: any) => <span className="font-mono text-[11px]">{r.input_no}</span> },
                { key: 'bundle_no', header: 'Bundle', render: (r: any) => <span className="font-mono text-[11px]">{r.bundle_no ?? '—'}</span> },
                { key: 'line_name', header: 'Line' },
                { key: 'input_qty', header: 'In', align: 'right' as const },
                { key: 'output_qty', header: 'Good', align: 'right' as const },
                { key: 'pending_qty', header: 'Pend', align: 'right' as const, render: (r: any) => num(r.pending_qty) > 0 && r.status !== 'CANCELLED' ? <b className="text-amber-700">{r.pending_qty}</b> : '—' },
                { key: 'status', header: '', render: (r: any) => <StatusBadge value={r.status} /> },
              ]} />
          </div>
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">All quantities in PCS. Click a row to load its bundle.</p>
        </Card>
      </div>
    </div>
  );
}

function Bal({ label, v, hi }: { label: string; v?: number; hi?: boolean }) {
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${hi ? 'border-brand-400 bg-brand-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${num(v) > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{fmtNumber(v ?? 0)} <span className="text-[10px] font-medium text-slate-400">PCS</span></p>
    </div>
  );
}

export default SewingFinishingFloorPage;
