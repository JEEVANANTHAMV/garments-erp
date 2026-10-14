import { useEffect, useMemo, useState } from 'react';
import { PackageMinus, PackagePlus, Ban } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Modal, DataTable, FormSection } from '../../../components/ui';
import { api } from '../../../lib/api';
import { fmtDate } from '../../../lib/format';
import { useToast } from '../../../hooks/useToast';
import { type Kind, BASE, ST_TONE, errMsg, num, human, money, rate4, qty, usePerm, useGet } from './shared';

/**
 * Store issue / return of thread, backing, dyes, chemicals … against a job (embroidery doc §8, printing doc §7),
 * from trims stock lots. Net consumption = issued − returned; production cannot consume more than the job holds.
 */
export function MaterialTab({ kind }: { kind: Kind }) {
  const toast = useToast();
  const p = usePerm(kind);
  const [f, setF] = useState({ type: '', from: '', to: '' });
  const list = useGet<any[]>(`${BASE[kind]}/material-txns`, { type: f.type || undefined, from: f.from || undefined, to: f.to || undefined });
  const [dlg, setDlg] = useState<'ISSUE' | 'RETURN' | null>(null);
  const cancel = async (t: any) => {
    const reason = window.prompt(`Cancel ${t.txn_type.toLowerCase()} ${t.txn_no} (${t.trim_code} ${qty(t.qty)} ${t.uom_code}) — reason:`);
    if (!reason) return;
    try { await api.post(`${BASE[kind]}/material-txns/${t.id}/cancel`, { reason }); toast('Cancelled — stock reversed'); void list.reload(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <Card title="Material issue & return" subtitle="Issued from trims stock lots against a job; unused material comes back to the same lot"
      actions={p.store && <div className="flex gap-2">
        <Button size="sm" id="mp-mat-issue" onClick={() => setDlg('ISSUE')}><PackageMinus size={13} className="mr-1 inline" />Issue</Button>
        <Button size="sm" variant="secondary" id="mp-mat-return" onClick={() => setDlg('RETURN')}><PackagePlus size={13} className="mr-1 inline" />Return</Button>
      </div>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Type" className="w-36" value={f.type} placeholder="All" onChange={(e) => setF({ ...f, type: e.target.value })} options={[{ value: 'ISSUE', label: 'Issue' }, { value: 'RETURN', label: 'Return' }]} />
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No material issued yet"
        columns={[
          { key: 'txn_no', header: 'Doc no', render: (r: any) => <span className="font-mono">{r.txn_no}</span> },
          { key: 'txn_date', header: 'Date', render: (r: any) => fmtDate(r.txn_date) },
          { key: 'txn_type', header: 'Type', render: (r: any) => <Badge tone={r.txn_type === 'ISSUE' ? 'blue' : 'violet'}>{human(r.txn_type)}</Badge> },
          { key: 'job_no', header: 'Job', render: (r: any) => <span>{r.job_no}{r.production_no ? <span className="text-slate-400"> · {r.production_no}</span> : null}</span> },
          { key: 'trim', header: 'Material', render: (r: any) => `${r.trim_code} · ${r.trim_name}` },
          { key: 'lot_no', header: 'Lot' },
          { key: 'qty', header: 'Qty', align: 'right' as const, render: (r: any) => `${qty(r.qty, 4)} ${r.uom_code ?? ''}` },
          ...(p.costing || p.store ? [{ key: 'amount', header: 'Value', align: 'right' as const, render: (r: any) => money(r.amount) }] : []),
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={ST_TONE[r.status]}>{human(r.status)}</Badge> },
          { key: 'by', header: 'By', render: (r: any) => r.created_by_name ?? '—' },
          { key: 'act', header: '', render: (r: any) => p.store && r.status === 'POSTED' ? <button className="text-xs text-red-600 hover:underline" onClick={() => cancel(r)}><Ban size={12} className="inline" /> Cancel</button> : null },
        ]} />
      {dlg && <MaterialDialog kind={kind} type={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); void list.reload(); }} />}
    </Card>
  );
}

export function MaterialDialog({ kind, type, jobId, productionId, onClose, onDone }: {
  kind: Kind; type: 'ISSUE' | 'RETURN'; jobId?: number; productionId?: number; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const jobs = useGet<any[]>(jobId ? null : `${BASE[kind]}/jobs`, { status: 'OPEN' });
  const [job, setJob] = useState<string>(jobId ? String(jobId) : '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState('');
  const [lots, setLots] = useState<any[]>([]);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [req, setReq] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setLots([]); setQtys({}); setReq(null);
    if (!job) return;
    void api.get(`${BASE[kind]}/jobs/${job}`).then((r) => setReq(r.data.data)).catch(() => setReq(null));
    if (type === 'ISSUE') {
      void api.get(`${BASE[kind]}/material-stock`, { params: { job_id: job } }).then((r) => setLots(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
    } else {
      // lots this job holds: issued − returned per stock lot
      void api.get(`${BASE[kind]}/material-txns`, { params: { job_id: job } }).then((r) => {
        const by = new Map<number, any>();
        for (const t of r.data.data as any[]) {
          if (t.status !== 'POSTED') continue;
          const k = Number(t.trim_stock_id);
          if (!by.has(k)) by.set(k, { trim_stock_id: k, trim_id: t.trim_id, trim_code: t.trim_code, trim_name: t.trim_name, lot_no: t.lot_no, uom_code: t.uom_code, warehouse_name: t.warehouse_name, available_qty: 0 });
          by.get(k).available_qty += (t.txn_type === 'ISSUE' ? 1 : -1) * num(t.qty);
        }
        setLots([...by.values()].filter((l) => l.available_qty > 0.00001));
      }).catch((e) => toast(errMsg(e), 'error'));
    }
  }, [job, type, kind]);
  const needOf = (trimId: number) => {
    const r = req?.requirement?.find((x: any) => Number(x.trim_id) === trimId);
    const m = req?.materials?.find((x: any) => Number(x.trim_id) === trimId);
    return { need: r ? num(r.stock_qty) : null, net: m ? num(m.net_issued) : 0, balance: m ? num(m.balance) : 0 };
  };
  const recipeTrims = new Set<number>((req?.requirement ?? []).map((r: any) => Number(r.trim_id)));
  const shownLots = type === 'ISSUE' && !all && recipeTrims.size ? lots.filter((l) => recipeTrims.has(Number(l.trim_id)) || num(qtys[l.trim_stock_id]) > 0) : lots;
  const lines = useMemo(() => Object.entries(qtys).filter(([, v]) => num(v) > 0).map(([k, v]) => ({ trim_stock_id: Number(k), qty: num(v) })), [qtys]);
  const post = async () => {
    setBusy(true);
    try {
      const r = await api.post(`${BASE[kind]}/${type === 'ISSUE' ? 'material-issues' : 'material-returns'}`, { job_id: Number(job), txn_date: date, production_id: productionId ?? null, remarks: remarks || null, lines });
      toast(`${type === 'ISSUE' ? 'Issued' : 'Returned'} — ${r.data.data.txn_no}`); onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open size="xl" onClose={onClose} title={type === 'ISSUE' ? 'Issue material to job' : 'Return unused material to store'}
      icon={type === 'ISSUE' ? <PackageMinus size={16} /> : <PackagePlus size={16} />}
      subtitle={type === 'ISSUE' ? "Pick the stock lots and quantities to issue against the job's recipe" : 'Unconsumed material held by the job goes back to its stock lot'}
      footerStart={job ? <><b>{lines.length}</b> lot(s) to post</> : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} id="mp-mat-post" disabled={!job || !lines.length} onClick={post}>{type === 'ISSUE' ? 'Post issue' : 'Post return'}</Button></>}>
      <div className="space-y-3">
        <FormSection cols={2}>
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {jobId ? <Input label="Job" disabled value={req?.job_no ?? ''} /> :
            <Select label="Job" required id="mp-mat-job" value={job} placeholder="— planned / running job —" onChange={(e) => setJob(e.target.value)}
              options={(jobs.data ?? []).filter((j: any) => ['PLANNED', 'RUNNING'].includes(j.status) || type === 'RETURN').map((j: any) => ({ value: j.id, label: `${j.job_no} · ${j.io_no ?? ''} ${j.style_code ?? ''} · ${human(j.status)}` }))} />}
        </FormSection>
        {job && <div className="overflow-x-auto">
          <h3 className="mb-2 border-b border-slate-100 pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">{type === 'ISSUE' ? 'Stock lots' : 'Lots held by the job'}</h3>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left">Material</th><th className="px-2 py-1 text-left">Lot</th><th className="px-2 py-1 text-left">Store</th>
              <th className="px-2 py-1 text-right">{type === 'ISSUE' ? 'In stock' : 'Issued to job (net)'}</th>
              <th className="px-2 py-1 text-right">Job standard</th><th className="px-2 py-1 text-right">Issued so far</th><th className="px-2 py-1 text-right">Unconsumed</th>
              {type === 'ISSUE' && <th className="px-2 py-1 text-right">Rate</th>}<th className="px-2 py-1 text-right">Qty</th>
            </tr></thead>
            <tbody>{shownLots.map((l) => {
              const n2 = needOf(Number(l.trim_id));
              return (
                <tr key={l.trim_stock_id} className="border-t border-slate-100">
                  <td className="px-2 py-1">{l.trim_code} · {l.trim_name}{l.stock_job ? <span className="text-slate-400"> · job {l.stock_job}</span> : null}</td>
                  <td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.warehouse_name}</td>
                  <td className="px-2 py-1 text-right">{qty(l.available_qty, 4)} {l.uom_code}</td>
                  <td className="px-2 py-1 text-right">{n2.need != null ? qty(n2.need, 4) : '—'}</td>
                  <td className="px-2 py-1 text-right">{qty(n2.net, 4)}</td>
                  <td className="px-2 py-1 text-right">{qty(n2.balance, 4)}</td>
                  {type === 'ISSUE' && <td className="px-2 py-1 text-right">{rate4(l.unit_cost)}</td>}
                  <td className="px-2 py-1 text-right"><input className="input h-8 w-24 text-right" type="number" min={0} step="any" id={`mp-mat-qty-${l.trim_id}`}
                    value={qtys[l.trim_stock_id] ?? ''} onChange={(e) => { const v = e.target.value; setQtys((q) => ({ ...q, [l.trim_stock_id]: v })); }} /></td>
                </tr>
              );
            })}</tbody>
          </table>
          {type === 'ISSUE' && recipeTrims.size > 0 && <label className="mt-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Show materials outside the job's recipe too ({lots.length - shownLots.length} more lots)</label>}
          {!lots.length && <p className="py-3 text-center text-xs text-slate-400">{type === 'ISSUE' ? 'No trims stock lots (general stock or this job\'s) — receive the material through a Trims GRN first' : 'Nothing issued to this job'}</p>}
          <p className="mt-2 text-[11px] text-slate-500">"Job standard" is the recipe requirement for the planned qty in stock units. Another job's lot must be transferred to this job first (Job Transfer).</p>
        </div>}
        <FormSection cols={1}>
          <Input label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </FormSection>
      </div>
    </Modal>
  );
}
