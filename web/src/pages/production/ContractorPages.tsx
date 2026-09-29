import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Ban, Search } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/**
 * Contractor piece-rate screens (client voice note 29-Sep-2026, "contract option"):
 *  - Job Rate Card: per job (IO no) pick only the operations it needs from the
 *    Process & Operations master and fix that job's rate (power table, singer, flatlock …)
 *  - Contractor Advances: advance paid to a contractor, recovered on contractor bills
 *  - Contractor Debit Notes: deduction for defective work, adjusted on a bill
 */

const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function useContractors() {
  const [rows, setRows] = useState<{ id: number; label: string }[]>([]);
  useEffect(() => { api.get('/process-dcs/contractors').then((r) => setRows(r.data.data || [])).catch(() => setRows([])); }, []);
  return rows;
}

// ───────────────────────────── Job Rate Card ─────────────────────────────
type CardRow = { operation_id: number; op_code: string; op_name: string; default_rate: number; selected: boolean; job_rate: number | null; remarks: string | null };

export function JobRateCardPage() {
  const toast = useToast();
  const [stages, setStages] = useState<{ id: number; stage_name: string }[]>([]);
  const [cards, setCards] = useState<any[]>([]);
  const [ioNo, setIoNo] = useState('');
  const [stageId, setStageId] = useState('');
  const [rows, setRows] = useState<CardRow[]>([]);
  const [edit, setEdit] = useState<Record<number, { on: boolean; rate: string; remarks: string }>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadCards = () => api.get('/job-rate-cards').then((r) => setCards(r.data.data || [])).catch(() => setCards([]));
  useEffect(() => {
    loadCards();
    api.get('/process-master').then((r) => {
      const st = (r.data.data || []).filter((x: any) => (x.operations || []).length);
      setStages(st);
      if (!stageId && st.length) setStageId(String((st.find((x: any) => String(x.stage_code).toUpperCase() === 'STITCH') ?? st[0]).id));
    }).catch(() => setStages([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCard = async (io = ioNo, st = stageId) => {
    if (!io.trim() || !st) { toast('Enter the job (IO no) and choose the process', 'warning'); return; }
    try {
      const r = await api.get('/job-rate-cards/card', { params: { io_no: io.trim(), stage_id: st } });
      const d: CardRow[] = r.data.data || [];
      setRows(d);
      setEdit(Object.fromEntries(d.map((o) => [o.operation_id, { on: o.selected, rate: o.job_rate != null ? String(o.job_rate) : String(o.default_rate || ''), remarks: o.remarks ?? '' }])));
      setLoaded(true);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  const total = useMemo(() => Object.values(edit).filter((e) => e.on).reduce((a, e) => a + num(e.rate), 0), [edit]);

  const save = async () => {
    setSaving(true);
    try {
      const operations = rows.filter((o) => edit[o.operation_id]?.on)
        .map((o) => ({ operation_id: o.operation_id, rate: num(edit[o.operation_id].rate), remarks: edit[o.operation_id].remarks || null }));
      await api.put('/job-rate-cards', { io_no: ioNo.trim(), stage_id: Number(stageId), operations });
      toast(`Rate card saved for ${ioNo.trim()} — ${operations.length} operation(s), ₹${total.toFixed(2)} / PCS`);
      loadCards(); loadCard();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Job Rate Card</h1>
        <p className="text-sm text-slate-500">For each job pick only the operations it needs from the Process & Operations master and fix the contractor piece rate. Process DCs and contractor bills use these rates.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Card title="Jobs with a rate card">
          <DataTable data={cards} emptyTitle="No job rate cards yet" onRowClick={(r: any) => { setIoNo(r.io_no); setStageId(String(r.stage_id)); loadCard(r.io_no, String(r.stage_id)); }}
            columns={[
              { key: 'io_no', header: 'Job (IO)', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.io_no}</span> },
              { key: 'stage_name', header: 'Process' },
              { key: 'style_code', header: 'Style', render: (r: any) => r.style_code || '—' },
              { key: 'operations', header: 'Operations', align: 'right' as const },
              { key: 'total_rate', header: '₹ / PCS', align: 'right' as const, render: (r: any) => <b>{num(r.total_rate).toFixed(2)}</b> },
              { key: 'updated_at', header: 'Updated', render: (r: any) => fmtDate(r.updated_at) },
            ]} />
        </Card>
        <Card title="Rate card">
          <div className="flex flex-wrap items-end gap-3 p-3">
            <Input label="Job (IO no)" className="w-48" value={ioNo} onChange={(e) => { setIoNo(e.target.value.toUpperCase()); setLoaded(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') loadCard(); }} placeholder="e.g. IO-2026-0012" />
            <Select label="Process" className="w-44" value={stageId} onChange={(e) => { setStageId(e.target.value); setLoaded(false); }}
              options={stages.map((s) => ({ value: s.id, label: s.stage_name }))} />
            <Button variant="secondary" className="!h-10" onClick={() => loadCard()}><Search size={14} className="mr-1 inline" />Load</Button>
          </div>
          {loaded && (
            <>
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="w-8 px-3 py-2" /><th className="px-3 py-2 text-left">Operation</th>
                  <th className="px-3 py-2 text-right">Master rate</th><th className="px-3 py-2 text-right">Job rate (₹ / PCS)</th><th className="px-3 py-2 text-left">Remarks</th>
                </tr></thead>
                <tbody>
                  {rows.map((o) => {
                    const e = edit[o.operation_id] ?? { on: false, rate: '', remarks: '' };
                    return (
                      <tr key={o.operation_id} className={`border-t border-slate-100 ${e.on ? 'bg-brand-50/40' : ''}`}>
                        <td className="px-3 py-1.5 text-center"><input type="checkbox" checked={e.on} onChange={() => setEdit((c) => ({ ...c, [o.operation_id]: { ...e, on: !e.on } }))} /></td>
                        <td className="px-3 py-1.5 font-medium">{o.op_name} <span className="text-slate-400">{o.op_code}</span></td>
                        <td className="px-3 py-1.5 text-right text-slate-500">{num(o.default_rate).toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-right">
                          <input type="number" min={0} step="0.01" disabled={!e.on} className="input h-7 w-24 text-right text-xs" value={e.rate}
                            onChange={(ev) => setEdit((c) => ({ ...c, [o.operation_id]: { ...e, rate: ev.target.value } }))} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input disabled={!e.on} className="input h-7 w-40 text-xs" value={e.remarks}
                            onChange={(ev) => setEdit((c) => ({ ...c, [o.operation_id]: { ...e, remarks: ev.target.value } }))} />
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">This process has no operations — add them in Process & Operations.</td></tr>}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
                <span>{Object.values(edit).filter((e) => e.on).length} operation(s) · <b>₹{total.toFixed(2)} / PCS</b> for {ioNo}</span>
                <Button loading={saving} onClick={save}><Save size={13} className="mr-1 inline" />Save rate card</Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────────── Contractor Advances ─────────────────────────────
export function ContractorAdvancesPage() {
  const toast = useToast();
  const contractors = useContractors();
  const [vendor, setVendor] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [bal, setBal] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<any>({ vendor_id: '', advance_date: today(), amount: '', pay_mode: 'CASH', ref_no: '', remarks: '' });
  const [cancelRow, setCancelRow] = useState<any>(null);
  const [reason, setReason] = useState('');

  const load = () => {
    api.get('/contractor-advances', { params: { vendor_id: vendor || undefined } }).then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error'));
    if (vendor) api.get('/contractor-advances/balance', { params: { vendor_id: vendor } }).then((r) => setBal(r.data.data)).catch(() => setBal(null));
    else setBal(null);
  };
  useEffect(load, [vendor]);

  const save = async () => {
    try {
      const r = await api.post('/contractor-advances', { ...f, vendor_id: Number(f.vendor_id), amount: num(f.amount) });
      toast(`Advance ${r.data.data.advance_no} saved — open advance ${money(r.data.data.balance.balance)}`);
      setAdding(false); setVendor(String(f.vendor_id)); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const cancel = async () => {
    try { await api.post(`/contractor-advances/${cancelRow.id}/cancel`, { reason }); toast('Advance cancelled'); setCancelRow(null); load(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Contractor Advances</h1>
          <p className="text-sm text-slate-500">Advances paid to contractors, and bill excess kept as advance — recovered through "Advance adjust" on contractor bills</p>
        </div>
        <Button onClick={() => { setF({ vendor_id: vendor, advance_date: today(), amount: '', pay_mode: 'CASH', ref_no: '', remarks: '' }); setAdding(true); }}><Plus size={14} className="mr-1 inline" />New advance</Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-4 p-3">
          <Select label="Contractor" className="w-72" value={vendor} placeholder="All contractors" onChange={(e) => setVendor(e.target.value)}
            options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
          {bal && <span className="pb-2 text-sm">Given <b>{money(bal.advanced)}</b> · adjusted on bills <b>{money(bal.adjusted)}</b> · <b className="text-emerald-700">open {money(bal.balance)}</b></span>}
        </div>
        <DataTable data={rows} emptyTitle="No advances"
          columns={[
            { key: 'advance_no', header: 'Advance no', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.advance_no}</span> },
            { key: 'advance_date', header: 'Date', render: (r: any) => fmtDate(r.advance_date) },
            { key: 'vendor_name', header: 'Contractor' },
            { key: 'source', header: 'Source', render: (r: any) => (r.source === 'BILL_EXCESS' ? <Badge tone="amber">Bill excess {r.bill_no}</Badge> : <Badge tone="blue">Payment{r.pay_mode ? ` · ${r.pay_mode}` : ''}</Badge>) },
            { key: 'ref_no', header: 'Ref', render: (r: any) => r.ref_no || '—' },
            { key: 'amount', header: 'Amount', align: 'right' as const, render: (r: any) => <b>{money(r.amount)}</b> },
            { key: 'status', header: 'Status', render: (r: any) => <Badge tone={r.status === 'ACTIVE' ? 'green' : 'red'}>{r.status}</Badge> },
            { key: 'act', header: '', render: (r: any) => (r.status === 'ACTIVE' && r.source === 'PAYMENT'
              ? <Button size="sm" variant="ghost" onClick={() => { setReason(''); setCancelRow(r); }}><Ban size={12} /></Button> : null) },
          ]} />
      </Card>
      {adding && (
        <Modal open onClose={() => setAdding(false)} title="New contractor advance"
          footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={!f.vendor_id || !(num(f.amount) > 0)} onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Contractor" required value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })} placeholder="— choose —"
              options={contractors.map((c) => ({ value: c.id, label: c.label }))} className="col-span-2" />
            <Input label="Date" type="date" value={f.advance_date} onChange={(e) => setF({ ...f, advance_date: e.target.value })} />
            <Input label="Amount (₹)" type="number" min={0} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <Select label="Mode" value={f.pay_mode} onChange={(e) => setF({ ...f, pay_mode: e.target.value })} options={['CASH', 'BANK', 'UPI', 'CHEQUE'].map((v) => ({ value: v, label: v }))} />
            <Input label="Ref / cheque no" value={f.ref_no} onChange={(e) => setF({ ...f, ref_no: e.target.value })} />
            <Textarea label="Remarks" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} className="col-span-2" rows={2} />
          </div>
        </Modal>
      )}
      {cancelRow && (
        <Modal open onClose={() => setCancelRow(null)} size="sm" title={`Cancel advance ${cancelRow.advance_no}`}
          footer={<><Button variant="secondary" onClick={() => setCancelRow(null)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={cancel}>Cancel advance</Button></>}>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}

// ───────────────────────────── Contractor Debit Notes ─────────────────────────────
const DN_TONE: Record<string, string> = { OPEN: 'amber', ADJUSTED: 'green', CANCELLED: 'red' };

export function ContractorDebitNotesPage() {
  const toast = useToast();
  const contractors = useContractors();
  const [vendor, setVendor] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<any>({ vendor_id: '', dn_date: today(), io_no: '', reason: '', qty: '', rate: '', amount: '' });
  const [cancelRow, setCancelRow] = useState<any>(null);
  const [reason, setReason] = useState('');

  const load = () => api.get('/contractor-debit-notes', { params: { vendor_id: vendor || undefined } }).then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [vendor]);

  const amount = f.amount !== '' ? num(f.amount) : num(f.qty) * num(f.rate);
  const save = async () => {
    try {
      const r = await api.post('/contractor-debit-notes', {
        vendor_id: Number(f.vendor_id), dn_date: f.dn_date, io_no: f.io_no || null, reason: f.reason,
        qty: num(f.qty), rate: num(f.rate), amount: f.amount !== '' ? num(f.amount) : undefined,
      });
      toast(`Debit note ${r.data.data.dn_no} for ${money(r.data.data.amount)} — deduct it on the next contractor bill`);
      setAdding(false); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const cancel = async () => {
    try { await api.post(`/contractor-debit-notes/${cancelRow.id}/cancel`, { reason }); toast('Debit note cancelled'); setCancelRow(null); load(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Contractor Debit Notes</h1>
          <p className="text-sm text-slate-500">Charge a contractor for defective work (wrong stitching, damage) — deducted on a contractor bill</p>
        </div>
        <Button onClick={() => { setF({ vendor_id: vendor, dn_date: today(), io_no: '', reason: '', qty: '', rate: '', amount: '' }); setAdding(true); }}><Plus size={14} className="mr-1 inline" />New debit note</Button>
      </div>
      <Card>
        <div className="p-3">
          <Select label="Contractor" className="w-72" value={vendor} placeholder="All contractors" onChange={(e) => setVendor(e.target.value)}
            options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
        </div>
        <DataTable data={rows} emptyTitle="No debit notes"
          columns={[
            { key: 'dn_no', header: 'DN no', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.dn_no}</span> },
            { key: 'dn_date', header: 'Date', render: (r: any) => fmtDate(r.dn_date) },
            { key: 'vendor_name', header: 'Contractor' },
            { key: 'io_no', header: 'Job', render: (r: any) => r.io_no || '—' },
            { key: 'reason', header: 'Reason' },
            { key: 'qty', header: 'PCS × rate', align: 'right' as const, render: (r: any) => (num(r.qty) ? `${fmtNumber(r.qty)} × ${num(r.rate).toFixed(2)}` : '—') },
            { key: 'amount', header: 'Amount', align: 'right' as const, render: (r: any) => <b>{money(r.amount)}</b> },
            { key: 'status', header: 'Status', render: (r: any) => <span><Badge tone={DN_TONE[r.status] ?? 'slate'}>{r.status}</Badge>{r.bill_no ? <span className="ml-1 text-[11px] text-slate-500">on {r.bill_no}</span> : null}</span> },
            { key: 'act', header: '', render: (r: any) => (r.status === 'OPEN' ? <Button size="sm" variant="ghost" onClick={() => { setReason(''); setCancelRow(r); }}><Ban size={12} /></Button> : null) },
          ]} />
      </Card>
      {adding && (
        <Modal open onClose={() => setAdding(false)} title="New contractor debit note"
          footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={!f.vendor_id || f.reason.trim().length < 3 || !(amount > 0)} onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Contractor" required value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })} placeholder="— choose —"
              options={contractors.map((c) => ({ value: c.id, label: c.label }))} className="col-span-2" />
            <Input label="Date" type="date" value={f.dn_date} onChange={(e) => setF({ ...f, dn_date: e.target.value })} />
            <Input label="Job (IO no)" value={f.io_no} onChange={(e) => setF({ ...f, io_no: e.target.value.toUpperCase() })} />
            <Input label="Reason" required value={f.reason} placeholder="e.g. Wrong stitching — 40 PCS" onChange={(e) => setF({ ...f, reason: e.target.value })} className="col-span-2" />
            <Input label="PCS" type="number" min={0} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
            <Input label="Rate (₹ / PCS)" type="number" min={0} step="0.01" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            <Input label="Amount (₹)" type="number" min={0} step="0.01" value={f.amount} hint={`Blank = PCS × rate (${money(num(f.qty) * num(f.rate))})`}
              onChange={(e) => setF({ ...f, amount: e.target.value })} className="col-span-2" />
          </div>
        </Modal>
      )}
      {cancelRow && (
        <Modal open onClose={() => setCancelRow(null)} size="sm" title={`Cancel debit note ${cancelRow.dn_no}`}
          footer={<><Button variant="secondary" onClick={() => setCancelRow(null)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={cancel}>Cancel debit note</Button></>}>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}
