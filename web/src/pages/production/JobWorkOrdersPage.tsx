import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Save, Ban, CheckCircle2, Lock, Truck, PackageCheck, Trash2, GitBranch } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { JobSelect } from '../../components/JobSelect';

/**
 * External job work / subcontracting (client document "External Job Work Subcontracting" + voice note 05-Oct-2026).
 * One engine for every process — the process is configuration:
 *   Job Work Order (process route, approved) → Outward DC (bundle DC from Process Outward, or fabric DC here)
 *   → contractor stock → Inward (good / reject / shortage / loss / unprocessed return / rework) → QC
 *   → reconciliation → contractor bill → advance / debit / credit / payment → contractor statement.
 */

const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ST_TONE: Record<string, string> = {
  DRAFT: 'slate', APPROVED: 'blue', PARTIAL_OUTWARD: 'violet', IN_PROCESS: 'amber', PARTIAL_INWARD: 'amber', COMPLETED: 'green', CLOSED: 'green', CANCELLED: 'red',
};
const human = (s: string) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function useContractors() {
  const [rows, setRows] = useState<{ id: number; label: string }[]>([]);
  useEffect(() => { api.get('/process-dcs/contractors').then((r) => setRows(r.data.data || [])).catch(() => setRows([])); }, []);
  return rows;
}

// ───────────────────────────── Job Work Orders ─────────────────────────────
export function JobWorkOrdersPage() {
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const contractors = useContractors();
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState({ vendor_id: '', status: '', q: '' });
  const [editing, setEditing] = useState<any>(null);
  const openId = sp.get('open');
  const load = () => api.get('/job-work/orders', { params: { vendor_id: f.vendor_id || undefined, status: f.status || undefined, q: f.q || undefined } })
    .then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [f.vendor_id, f.status]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Job Work Orders</h1>
          <p className="text-sm text-slate-500">What a contractor does for a job, by process route — DCs are sent against the approved order balance; the order closes only when the contractor holds nothing</p>
        </div>
        <Button id="jw-new" onClick={() => setEditing({})}><Plus size={14} className="mr-1 inline" />New job work order</Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Select label="Contractor" className="w-64" value={f.vendor_id} placeholder="All contractors" onChange={(e) => setF({ ...f, vendor_id: e.target.value })}
            options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
          <Select label="Status" className="w-48" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })}
            options={Object.keys(ST_TONE).map((k) => ({ value: k, label: human(k) }))} />
          <form onSubmit={(e) => { e.preventDefault(); load(); }} className="flex items-end gap-2">
            <Input label="Search" placeholder="JWO no / job / contractor" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            <Button type="submit" variant="secondary">Find</Button>
          </form>
        </div>
        <DataTable data={rows} emptyTitle="No job work orders"
          columns={[
            { key: 'jw_no', header: 'Order no', render: (r: any) => <button className="font-mono font-semibold text-brand-700 hover:underline" id={`jw-open-${r.id}`} onClick={() => setSp({ open: String(r.id) })}>{r.jw_no}</button> },
            { key: 'order_date', header: 'Date', render: (r: any) => fmtDate(r.order_date) },
            { key: 'vendor_name', header: 'Contractor' },
            { key: 'io_no', header: 'Job / style', render: (r: any) => <span>{r.io_no ?? '—'}{r.style_code ? <span className="text-slate-500"> · {r.style_code}</span> : null}</span> },
            { key: 'processes', header: 'Process route' },
            { key: 'outward', header: 'Planned / out / good', align: 'right' as const, render: (r: any) => `${fmtNumber(r.planned)} / ${fmtNumber(r.outward)} / ${fmtNumber(r.good)}` },
            { key: 'contractor_pcs', header: 'With contractor', align: 'right' as const, render: (r: any) => <span className={r.contractor_pcs || r.contractor_kg ? 'font-semibold text-amber-700' : 'text-slate-400'}>
              {r.contractor_pcs ? `${fmtNumber(r.contractor_pcs)} PCS` : ''}{r.contractor_kg ? ` ${r.contractor_kg} KG` : ''}{!r.contractor_pcs && !r.contractor_kg ? '—' : ''}</span> },
            { key: 'expected_return_date', header: 'Expected back', render: (r: any) => <span className={r.overdue ? 'font-semibold text-red-600' : ''}>{fmtDate(r.expected_return_date)}{r.overdue ? ' · overdue' : ''}</span> },
            { key: 'status', header: 'Status', render: (r: any) => <Badge tone={ST_TONE[r.status] as any}>{human(r.status)}</Badge> },
          ]} />
      </Card>
      {editing && <OrderEditor order={editing} onClose={() => setEditing(null)} onSaved={(id) => { setEditing(null); load(); setSp({ open: String(id) }); }} />}
      {openId && <OrderDetail id={Number(openId)} onClose={() => { setSp({}); load(); }} onEdit={(o) => { setSp({}); setEditing(o); }} />}
    </div>
  );
}

type RouteLine = {
  stage_id: string; input_kind: string; input_uom: string; input_desc: string; output_kind: string; output_desc: string; output_uom: string;
  planned_input_qty: string; expected_output_qty: string; loss_tolerance_pct: string; rate: string; rate_basis: string;
};
const blankLine = (): RouteLine => ({ stage_id: '', input_kind: 'BUNDLE', input_uom: 'PCS', input_desc: '', output_kind: 'GARMENT', output_desc: '', output_uom: 'PCS',
  planned_input_qty: '', expected_output_qty: '', loss_tolerance_pct: '', rate: '', rate_basis: 'PCS' });

function OrderEditor({ order, onClose, onSaved }: { order: any; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const contractors = useContractors();
  const stages = useLookup('process-stages');
  const [h, setH] = useState<any>({
    so_id: order.so_id ?? '', io_no: order.io_no ?? '', style_id: order.style_id ?? '', styles: [] as any[], vendor_id: order.vendor_id ?? '',
    order_date: order.order_date ? String(order.order_date).slice(0, 10) : today(),
    expected_return_date: order.expected_return_date ? String(order.expected_return_date).slice(0, 10) : '', remarks: order.remarks ?? '',
  });
  const [lines, setLines] = useState<RouteLine[]>(order.lines?.length ? order.lines.map((l: any) => ({
    stage_id: String(l.stage_id), input_kind: l.input_kind, input_uom: l.input_uom, input_desc: l.input_desc ?? '', output_kind: l.output_kind, output_desc: l.output_desc ?? '',
    output_uom: l.output_uom, planned_input_qty: String(num(l.planned_input_qty)), expected_output_qty: String(num(l.expected_output_qty)),
    loss_tolerance_pct: l.loss_tolerance_pct != null ? String(l.loss_tolerance_pct) : '', rate: l.rate != null ? String(l.rate) : '', rate_basis: l.rate_basis,
  })) : [blankLine()]);
  const [busy, setBusy] = useState(false);
  const setL = (i: number, p: Partial<RouteLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  // default rate from the process rate master (contractor + process + style + buyer)
  const fillRate = async (i: number, stageId: string, uom: string) => {
    if (!h.vendor_id || !stageId) return;
    try {
      const r = await api.get('/job-work/rates/resolve', { params: { vendor_id: h.vendor_id, stage_id: stageId, style_id: h.style_id || undefined, uom } });
      if (r.data.data) setLines((cur) => cur.map((l, j) => (j === i && !l.rate ? { ...l, rate: String(r.data.data.rate) } : l)));
    } catch { /* no rate on file */ }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        so_id: h.so_id ? Number(h.so_id) : null, io_no: h.io_no || null, style_id: h.style_id ? Number(h.style_id) : null, vendor_id: Number(h.vendor_id),
        order_date: h.order_date, expected_return_date: h.expected_return_date || null, remarks: h.remarks || null,
        lines: lines.map((l, i) => ({
          seq_no: (i + 1) * 10, stage_id: Number(l.stage_id), input_kind: l.input_kind, input_uom: l.input_kind === 'FABRIC' && l.input_uom === 'PCS' ? 'KG' : l.input_uom,
          input_desc: l.input_desc || null, output_kind: l.output_kind, output_desc: l.output_desc || null, output_uom: l.output_uom,
          planned_input_qty: num(l.planned_input_qty), expected_output_qty: num(l.expected_output_qty),
          loss_tolerance_pct: l.loss_tolerance_pct === '' ? null : num(l.loss_tolerance_pct), rate: l.rate === '' ? null : num(l.rate), rate_basis: l.rate_basis,
        })),
      };
      const r = order.id ? await api.put(`/job-work/orders/${order.id}`, body) : await api.post('/job-work/orders', body);
      toast(`Job work order ${r.data.data.jw_no} saved (draft — approve it to send DCs)`); onSaved(r.data.data.id);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="full" title={order.id ? `Edit ${order.jw_no}` : 'New job work order'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} id="jw-save" disabled={!h.vendor_id || !lines.length || lines.some((l) => !l.stage_id || !(num(l.planned_input_qty) > 0))} onClick={save}><Save size={13} className="mr-1 inline" />Save draft</Button></>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <JobSelect value={h.so_id} by="so_id" id="jw-job" onPick={(j) => setH({ ...h, so_id: j?.id ?? '', io_no: j?.job_no ?? '', styles: j?.styles ?? [], style_id: j && j.styles.length === 1 ? j.styles[0].style_id : '' })} />
        <Select label="Style" id="jw-style" value={h.style_id} onChange={(e) => setH({ ...h, style_id: e.target.value })} placeholder="— style —"
          options={(h.styles.length ? h.styles : order.style_id ? [{ style_id: order.style_id, style_code: order.style_code }] : []).map((s: any) => ({ value: s.style_id, label: `${s.style_code}${s.style_name ? ` · ${s.style_name}` : ''}` }))} />
        <Select label="Contractor" required id="jw-vendor" value={h.vendor_id} onChange={(e) => setH({ ...h, vendor_id: e.target.value })} placeholder="— choose —"
          options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
        <Input label="Order date" type="date" value={h.order_date} onChange={(e) => setH({ ...h, order_date: e.target.value })} />
        <Input label="Expected return" type="date" value={h.expected_return_date} onChange={(e) => setH({ ...h, expected_return_date: e.target.value })} />
        <Input label="Remarks" className="md:col-span-3" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <h4 className="text-sm font-bold text-slate-700">Process route</h4>
        <Button size="sm" variant="secondary" id="jw-add-line" onClick={() => setLines([...lines, blankLine()])}><Plus size={12} className="mr-1 inline" />Add process</Button>
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            <th className="px-2 py-1 text-left">#</th><th className="px-2 py-1 text-left">Process</th><th className="px-2 py-1 text-left">Input</th><th className="px-2 py-1 text-left">UOM</th>
            <th className="px-2 py-1 text-left">Output</th><th className="px-2 py-1 text-right">Planned input</th><th className="px-2 py-1 text-right">Expected output</th>
            <th className="px-2 py-1 text-right">Loss tol. %</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-left">Per</th><th />
          </tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="px-2 py-1 text-slate-400">{(i + 1) * 10}</td>
              <td className="px-2 py-1"><select className="input h-8 w-36" id={`jw-line-${i}-stage`} value={l.stage_id} onChange={(e) => { setL(i, { stage_id: e.target.value }); void fillRate(i, e.target.value, l.rate_basis); }}>
                <option value="">— process —</option>{toOptions(stages.data).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
              <td className="px-2 py-1"><select className="input h-8 w-28" id={`jw-line-${i}-input`} value={l.input_kind}
                onChange={(e) => setL(i, { input_kind: e.target.value, input_uom: e.target.value === 'FABRIC' ? 'KG' : 'PCS', rate_basis: 'PCS' })}>
                <option value="BUNDLE">Cut bundles</option><option value="GARMENT">Garments</option><option value="FABRIC">Fabric rolls</option><option value="OTHER">Other</option></select></td>
              <td className="px-2 py-1"><select className="input h-8 w-20" value={l.input_uom} onChange={(e) => setL(i, { input_uom: e.target.value })}>
                {(l.input_kind === 'FABRIC' ? ['KG', 'M'] : ['PCS']).map((u) => <option key={u}>{u}</option>)}</select></td>
              <td className="px-2 py-1"><select className="input h-8 w-28" value={l.output_kind} onChange={(e) => setL(i, { output_kind: e.target.value })}>
                <option value="GARMENT">Garments</option><option value="PACKED">Packed garments</option><option value="PANEL">Panels</option><option value="OTHER">Other</option></select></td>
              <td className="px-2 py-1 text-right"><input className="input h-8 w-24 text-right" type="number" min={0} id={`jw-line-${i}-planned`} value={l.planned_input_qty} onChange={(e) => setL(i, { planned_input_qty: e.target.value })} /></td>
              <td className="px-2 py-1 text-right"><input className="input h-8 w-24 text-right" type="number" min={0} value={l.expected_output_qty} onChange={(e) => setL(i, { expected_output_qty: e.target.value })} /></td>
              <td className="px-2 py-1 text-right"><input className="input h-8 w-16 text-right" type="number" min={0} placeholder="2" value={l.loss_tolerance_pct} onChange={(e) => setL(i, { loss_tolerance_pct: e.target.value })} /></td>
              <td className="px-2 py-1 text-right"><input className="input h-8 w-20 text-right" type="number" min={0} step="0.01" id={`jw-line-${i}-rate`} value={l.rate} onChange={(e) => setL(i, { rate: e.target.value })} /></td>
              <td className="px-2 py-1"><select className="input h-8 w-20" value={l.rate_basis} onChange={(e) => setL(i, { rate_basis: e.target.value })}>
                {['PCS', 'KG', 'M', 'BUNDLE', 'CARTON'].map((u) => <option key={u}>{u}</option>)}</select></td>
              <td className="px-2 py-1"><button className="text-red-500" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="mt-2 text-[11px] text-slate-500">Fabric rolls in → garments / packed garments back (cutting + stitching + packing by the contractor). Rate fills from the process rate master when one is on file. Leave the tolerance blank to use the process / company setting.</p>
      </div>
    </Modal>
  );
}

function OrderDetail({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (o: any) => void }) {
  const toast = useToast();
  const [o, setO] = useState<any>(null);
  const [tab, setTab] = useState('balance');
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState<'close' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [fabricOut, setFabricOut] = useState<any>(null);
  const [fabricIn, setFabricIn] = useState<number | null>(null);
  const [gen, setGen] = useState<any>(null);
  const [ledger, setLedger] = useState<any[] | null>(null);
  const load = () => api.get(`/job-work/orders/${id}`).then((r) => setO(r.data.data)).catch((e) => { toast(errMsg(e), 'error'); onClose(); });
  useEffect(() => { load(); }, [id]);
  useEffect(() => {
    if (tab === 'genealogy') api.get(`/job-work/orders/${id}/genealogy`).then((r) => setGen(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
    if (tab === 'ledger') api.get(`/job-work/orders/${id}/ledger`).then((r) => setLedger(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
  }, [tab, id]);
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); setO(r.data.data); toast(msg); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  if (!o) return <Modal open onClose={onClose} title="Job work order"><p className="text-sm text-slate-500">Loading…</p></Modal>;
  const live = ['APPROVED', 'PARTIAL_OUTWARD', 'IN_PROCESS', 'PARTIAL_INWARD', 'COMPLETED'].includes(o.status);
  return (
    <Modal open onClose={onClose} size="full" title={`Job work order ${o.jw_no}`}
      footer={<>
        <div className="mr-auto flex gap-2">
          {!['CLOSED', 'CANCELLED'].includes(o.status) && <Button variant="danger" disabled={busy} onClick={() => { setReason(''); setReasonFor('cancel'); }}><Ban size={13} className="mr-1 inline" />Cancel</Button>}
          {live && <Button variant="secondary" id="jw-close" disabled={busy} onClick={() => { setReason(''); setReasonFor('close'); }}><Lock size={13} className="mr-1 inline" />Close order</Button>}
        </div>
        {o.status === 'DRAFT' && <Button variant="secondary" onClick={() => onEdit(o)}>Edit draft</Button>}
        {o.status === 'DRAFT' && <Button id="jw-approve" loading={busy} onClick={() => act(() => api.post(`/job-work/orders/${id}/approve`), `${o.jw_no} approved — DCs can now be sent`)}><CheckCircle2 size={13} className="mr-1 inline" />Approve</Button>}
        {live && <Link to="/production/jobwork-challans" className="btn-secondary"><Truck size={13} className="mr-1 inline" />Bundle DC (Process Outward)</Link>}
      </>}>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4 xl:grid-cols-6">
        <Info label="Status"><Badge tone={ST_TONE[o.status] as any}>{human(o.status)}</Badge></Info>
        <Info label="Contractor">{o.vendor_name}</Info>
        <Info label="Job">{o.io_no ?? '—'}{o.buyer_po_no ? ` · PO ${o.buyer_po_no}` : ''}</Info>
        <Info label="Style">{o.style_code ?? '—'}</Info>
        <Info label="Buyer">{o.buyer_name ?? '—'}</Info>
        <Info label="Order / expected back">{fmtDate(o.order_date)} → {fmtDate(o.expected_return_date)}</Info>
        <Info label="Approved">{o.approved_by_name ?? '—'}</Info>
        <Info label="Estimated gross">{money(o.financial.estimated_gross)}</Info>
        <Info label="Billed">{money(o.financial.billed)}</Info>
        <Info label="Debit / credit notes">{money(o.financial.debit_notes)} / {money(o.financial.credit_notes)}</Info>
        <Info label="Expected net">{money(o.financial.expected_net)}</Info>
        <Info label="Remarks">{o.remarks ?? '—'}</Info>
      </div>
      {(o.close_reason || o.cancel_reason) && <p className="mt-2 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">{o.cancel_reason ? `Cancelled: ${o.cancel_reason}` : `Closed: ${o.close_reason}`}</p>}
      <div className="mt-4">
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'balance', label: 'Process balance' }, { key: 'dcs', label: 'DCs & inwards', count: o.dcs.length }, { key: 'genealogy', label: 'Genealogy' }, { key: 'ledger', label: 'Ledger' }]} />
        {tab === 'balance' && (
          <table className="w-full text-xs" id="jw-balance">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left">#</th><th className="px-2 py-1 text-left">Process</th><th className="px-2 py-1 text-left">Input → output</th>
              <th className="px-2 py-1 text-right">Planned</th><th className="px-2 py-1 text-right">Outward</th><th className="px-2 py-1 text-right">Pending outward</th>
              <th className="px-2 py-1 text-right">Good</th><th className="px-2 py-1 text-right">Reject</th><th className="px-2 py-1 text-right">Short + loss</th>
              <th className="px-2 py-1 text-right">Returned</th><th className="px-2 py-1 text-right">Rework open</th><th className="px-2 py-1 text-right">With contractor</th>
              <th className="px-2 py-1 text-right">Rate</th><th />
            </tr></thead>
            <tbody>{o.lines.map((l: any) => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-400">{l.seq_no}</td><td className="px-2 py-1 font-semibold">{l.stage_name}</td>
                <td className="px-2 py-1">{human(l.input_kind)} ({l.input_uom}) → {human(l.output_kind)}</td>
                <td className="px-2 py-1 text-right">{fmtNumber(l.planned)} {l.balance_uom}</td><td className="px-2 py-1 text-right">{fmtNumber(l.outward)}</td>
                <td className="px-2 py-1 text-right">{fmtNumber(l.pending_outward)}</td><td className="px-2 py-1 text-right text-emerald-700">{fmtNumber(l.good)}</td>
                <td className="px-2 py-1 text-right text-red-600">{fmtNumber(l.reject)}</td><td className="px-2 py-1 text-right text-orange-600">{fmtNumber(l.loss)}</td>
                <td className="px-2 py-1 text-right">{fmtNumber(l.returned)}</td><td className="px-2 py-1 text-right text-violet-700">{fmtNumber(l.rework_open)}</td>
                <td className="px-2 py-1 text-right font-semibold text-amber-700">{l.contractor_pcs ? `${fmtNumber(l.contractor_pcs)} PCS` : ''}{l.contractor_kg ? ` ${l.contractor_kg} KG` : ''}{!l.contractor_pcs && !l.contractor_kg ? '—' : ''}</td>
                <td className="px-2 py-1 text-right">{l.rate != null ? `${money(l.rate)}/${l.rate_basis}` : '—'}</td>
                <td className="px-2 py-1">{live && l.input_kind === 'FABRIC' && <Button size="sm" id={`jw-fabric-out-${l.id}`} onClick={() => setFabricOut(l)}><Truck size={12} className="mr-1 inline" />Fabric DC</Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        {tab === 'dcs' && (
          <div className="space-y-4">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-2 py-1 text-left">DC</th><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Process</th><th className="px-2 py-1 text-left">Kind</th>
                <th className="px-2 py-1 text-right">PCS</th><th className="px-2 py-1 text-right">Fabric KG (bal)</th><th className="px-2 py-1 text-right">Good</th><th className="px-2 py-1 text-right">Reject</th>
                <th className="px-2 py-1 text-right">Loss</th><th className="px-2 py-1 text-right">Returned</th><th className="px-2 py-1 text-right">Pending</th><th className="px-2 py-1 text-left">Status</th><th />
              </tr></thead>
              <tbody>{o.dcs.map((d: any) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{d.challan_no}</td><td className="px-2 py-1">{fmtDate(d.challan_date)}</td><td className="px-2 py-1">{d.stage_name}</td>
                  <td className="px-2 py-1"><Badge tone={d.dc_kind === 'FABRIC' ? 'violet' : 'blue'}>{d.dc_kind}</Badge></td>
                  <td className="px-2 py-1 text-right">{fmtNumber(d.total_qty)}</td>
                  <td className="px-2 py-1 text-right">{num(d.fabric_kg) ? `${num(d.fabric_kg)} (${num(d.fabric_balance_kg)})` : '—'}</td>
                  <td className="px-2 py-1 text-right text-emerald-700">{fmtNumber(d.good)}</td><td className="px-2 py-1 text-right text-red-600">{fmtNumber(d.reject)}</td>
                  <td className="px-2 py-1 text-right">{fmtNumber(d.loss)}</td><td className="px-2 py-1 text-right">{fmtNumber(d.returned)}</td>
                  <td className="px-2 py-1 text-right font-semibold">{fmtNumber(d.pending)}</td><td className="px-2 py-1">{human(d.status)}</td>
                  <td className="px-2 py-1">{d.dc_kind === 'FABRIC' && d.status !== 'CANCELLED' && (num(d.pending) > 0 || num(d.fabric_balance_kg) > 0) &&
                    <Button size="sm" id={`jw-fabric-in-${d.id}`} onClick={() => setFabricIn(d.id)}><PackageCheck size={12} className="mr-1 inline" />Inward</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
            {o.receipts.length > 0 && (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="px-2 py-1 text-left">Inward</th><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-right">Good</th><th className="px-2 py-1 text-right">Reject</th>
                  <th className="px-2 py-1 text-right">Short</th><th className="px-2 py-1 text-right">Loss</th><th className="px-2 py-1 text-right">Returned</th><th className="px-2 py-1 text-right">Rework</th>
                  <th className="px-2 py-1 text-left">QC</th><th className="px-2 py-1 text-left">Bill</th>
                </tr></thead>
                <tbody>{o.receipts.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono">{r.receipt_no}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(r.received_qty)}</td><td className="px-2 py-1 text-right">{fmtNumber(r.rejected_qty)}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(r.shortage_qty)}</td><td className="px-2 py-1 text-right">{fmtNumber(r.loss_qty)}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(r.return_qty)}</td><td className="px-2 py-1 text-right">{fmtNumber(r.rework_qty)}</td>
                    <td className="px-2 py-1">{num(r.received_qty) ? <Badge tone={r.qc_status === 'ACCEPTED' ? 'green' : r.qc_status === 'REJECTED' ? 'red' : 'amber'}>{r.qc_status}</Badge> : '—'}</td>
                    <td className="px-2 py-1">{r.bill_no ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="text-[11px] text-slate-500">Bundle DCs are inwarded (good / reject / loss / return / rework, QC) from <Link className="text-brand-700 underline" to="/production/jobwork-challans">Process Outward</Link>; bills from <Link className="text-brand-700 underline" to="/production/process-master">Contractor Bills</Link>.</p>
          </div>
        )}
        {tab === 'genealogy' && (gen ? <Genealogy g={gen} /> : <p className="text-sm text-slate-500">Loading…</p>)}
        {tab === 'ledger' && (ledger ? (
          <table className="w-full text-xs" id="jw-ledger">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Movement</th><th className="px-2 py-1 text-left">Ref</th><th className="px-2 py-1 text-left">Detail</th></tr></thead>
            <tbody>{ledger.map((r, i) => (
              <tr key={i} className="border-t border-slate-100"><td className="px-2 py-1">{fmtDate(r.date)}</td><td className="px-2 py-1 font-semibold">{r.type}</td><td className="px-2 py-1 font-mono">{r.ref}</td>
                <td className="px-2 py-1 text-slate-600">{Object.entries(r).filter(([k, v]) => !['date', 'type', 'ref'].includes(k) && v != null && v !== 0).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}</td></tr>
            ))}</tbody>
          </table>
        ) : <p className="text-sm text-slate-500">Loading…</p>)}
      </div>
      {reasonFor && (
        <Modal open onClose={() => setReasonFor(null)} size="sm" title={reasonFor === 'close' ? `Close ${o.jw_no}` : `Cancel ${o.jw_no}`}
          footer={<><Button variant="secondary" onClick={() => setReasonFor(null)}>Back</Button>
            <Button variant="danger" id="jw-reason-confirm" disabled={reason.trim().length < 3} onClick={() => { const f = reasonFor; setReasonFor(null); void act(() => api.post(`/job-work/orders/${id}/${f}`, { reason }), f === 'close' ? 'Order closed' : 'Order cancelled'); }}>Confirm</Button></>}>
          <p className="mb-2 text-xs text-slate-600">{reasonFor === 'close' ? 'An order closes only when the contractor holds nothing: every DC received, returned or closed, every fabric roll reconciled.' : 'Only an order without DCs can be cancelled.'}</p>
          <Textarea label="Reason" id="jw-reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
      {fabricOut && <FabricOutwardModal order={o} line={fabricOut} onClose={() => setFabricOut(null)} onDone={() => { setFabricOut(null); load(); setTab('dcs'); }} />}
      {fabricIn && <FabricInwardModal dcId={fabricIn} onClose={() => setFabricIn(null)} onDone={() => { setFabricIn(null); load(); }} />}
    </Modal>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div><div className="font-medium text-slate-800">{children}</div></div>;
}

function Genealogy({ g }: { g: any }) {
  return (
    <div className="space-y-3 text-xs" id="jw-genealogy">
      <p className="font-semibold text-slate-700"><GitBranch size={13} className="mr-1 inline" />{g.order.jw_no} · {g.order.io_no ?? '—'} · {g.order.style_code ?? ''} · {g.order.vendor_name}</p>
      {g.processes.map((p: any) => (
        <div key={p.id} className="rounded-lg border border-slate-200 p-2">
          <p className="font-bold">{p.seq_no}. {p.stage_name} — {fmtNumber(p.outward)} {p.balance_uom} out · {fmtNumber(p.good)} good · {fmtNumber(p.reject)} reject</p>
          {p.dcs.length === 0 && <p className="text-slate-400">No DC yet</p>}
          {p.dcs.map((d: any) => (
            <div key={d.id} className="ml-4 mt-1 border-l-2 border-slate-200 pl-2">
              <p><b className="font-mono">{d.challan_no}</b> {fmtDate(d.challan_date)} · {d.dc_kind} · {human(d.status)}</p>
              {d.rolls.length > 0 && <p className="text-slate-600">Rolls: {d.rolls.map((r: any) => `${r.roll_no}${r.grn_no ? ` (GRN ${r.grn_no})` : ''} ${num(r.issue_kg)} KG → used ${num(r.consumed_kg)} · back ${num(r.returned_kg)} · waste ${num(r.waste_kg)}`).join('; ')}</p>}
              {d.bundles.length > 0 && <p className="text-slate-600">Bundles: {d.bundles.map((b: any) => `${b.bundle_no ?? `${b.color_name ?? ''} ${b.size_code ?? ''}`} ${b.qty}`).join(', ')}</p>}
              {d.receipts.map((r: any) => <p key={r.id} className="ml-3 text-emerald-700">↳ {r.receipt_no} {fmtDate(r.receipt_date)}: good {r.received_qty}, reject {r.rejected_qty}, loss {num(r.loss_qty) + num(r.shortage_qty)}, returned {num(r.return_qty)}, rework {num(r.rework_qty)} · QC {r.qc_status}{r.bill_no ? ` · bill ${r.bill_no}` : ''}</p>)}
            </div>
          ))}
        </div>
      ))}
      {g.bills.length > 0 && <p>Bills: {g.bills.map((b: any) => `${b.bill_no} (${human(b.status)}, ${money(b.net_amount)})`).join(', ')}</p>}
    </div>
  );
}

function FabricOutwardModal({ order, line, onClose, onDone }: { order: any; line: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [opts, setOpts] = useState<{ rolls: any[]; skus: any[] } | null>(null);
  const [kg, setKg] = useState<Record<number, string>>({});
  const [qty, setQty] = useState<Record<string, string>>({});
  const [h, setH] = useState({ dc_date: today(), expected_return: order.expected_return_date ? String(order.expected_return_date).slice(0, 10) : '', vehicle_no: '', remarks: '', override_reason: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/job-work/orders/${order.id}/fabric-options`).then((r) => setOpts(r.data.data)).catch((e) => toast(errMsg(e), 'error')); }, [order.id]);
  const totalKg = Object.values(kg).reduce((a, v) => a + num(v), 0);
  const totalPcs = Object.values(qty).reduce((a, v) => a + num(v), 0);
  const over = num(line.planned) > 0 && num(line.outward) + totalKg > num(line.planned) + 0.0005;
  const colours = useMemo(() => [...new Set((opts?.skus ?? []).map((k) => k.color_name))], [opts]);
  const sizes = useMemo(() => [...new Map((opts?.skus ?? []).map((k) => [k.size_id, k])).values()], [opts]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/job-work/orders/${order.id}/fabric-outward`, {
        line_id: line.id, dc_date: h.dc_date, expected_return: h.expected_return || null, vehicle_no: h.vehicle_no || null, remarks: h.remarks || null,
        override_reason: h.override_reason || null,
        rolls: Object.entries(kg).filter(([, v]) => num(v) > 0).map(([id, v]) => ({ fabric_roll_id: Number(id), issue_kg: num(v) })),
        outputs: Object.entries(qty).filter(([, v]) => num(v) > 0).map(([k, v]) => { const [c, s] = k.split('|'); return { color_id: Number(c), size_id: Number(s), qty: num(v) }; }),
      });
      toast(`Fabric DC ${r.data.data.challan_no} — ${r.data.data.total_kg} KG from ${r.data.data.rolls} roll(s), ${r.data.data.expected_pcs} PCS expected`); onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="full" title={`Fabric outward — ${order.jw_no} · ${line.stage_name} · ${order.vendor_name}`}
      footer={<><span className="mr-auto self-center text-xs text-slate-600">{totalKg.toFixed(3)} KG · {totalPcs} PCS expected back · order {fmtNumber(line.outward)} of {fmtNumber(line.planned)} KG sent</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} id="jwf-save" disabled={!totalKg || !totalPcs || (over && h.override_reason.trim().length < 3)} onClick={save}><Truck size={13} className="mr-1 inline" />Issue fabric DC</Button></>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Input label="DC date" type="date" value={h.dc_date} onChange={(e) => setH({ ...h, dc_date: e.target.value })} />
        <Input label="Expected return" type="date" value={h.expected_return} onChange={(e) => setH({ ...h, expected_return: e.target.value })} />
        <Input label="Vehicle no" value={h.vehicle_no} onChange={(e) => setH({ ...h, vehicle_no: e.target.value.toUpperCase() })} />
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
        {over && <Input label="Over the planned KG — manager override reason" id="jwf-override" className="md:col-span-4" value={h.override_reason} onChange={(e) => setH({ ...h, override_reason: e.target.value })} />}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div>
          <h4 className="mb-1 text-sm font-bold text-slate-700">Fabric rolls (free stock of the job)</h4>
          {!opts ? <p className="text-xs text-slate-500">Loading…</p> : opts.rolls.length === 0 ? <p className="text-xs text-slate-500">No free QC-accepted roll for this job.</p> : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Roll</th><th className="px-2 py-1 text-left">Lot</th><th className="px-2 py-1 text-left">Fabric</th>
                <th className="px-2 py-1 text-right">Free KG</th><th className="px-2 py-1 text-right">Issue KG</th></tr></thead>
              <tbody>{opts.rolls.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.lot_no ?? '—'}</td><td className="px-2 py-1">{r.fabric_name}{r.color_name ? ` · ${r.color_name}` : ''}{!r.so_id ? <span className="text-slate-400"> (no job)</span> : null}</td>
                  <td className="px-2 py-1 text-right">{num(r.free_kg)}</td>
                  <td className="px-2 py-1 text-right"><div className="flex justify-end gap-1">
                    <input className={`input h-7 w-20 text-right ${num(kg[r.id]) > num(r.free_kg) ? 'input-error' : ''}`} type="number" min={0} step="0.001" id={`jwf-roll-${r.id}`} value={kg[r.id] ?? ''} onChange={(e) => setKg({ ...kg, [r.id]: e.target.value })} />
                    <button className="text-[11px] text-brand-700" onClick={() => setKg({ ...kg, [r.id]: String(num(r.free_kg)) })}>all</button></div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-sm font-bold text-slate-700">Garments expected back (colour × size)</h4>
          {!opts ? null : opts.skus.length === 0 ? <p className="text-xs text-slate-500">The style has no SKUs — generate them on the style first.</p> : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Colour</th>{sizes.map((s) => <th key={s.size_id} className="px-2 py-1 text-right">{s.size_code}</th>)}</tr></thead>
              <tbody>{colours.map((c) => (
                <tr key={c} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{c}</td>
                  {sizes.map((s) => { const k = opts.skus.find((x) => x.color_name === c && x.size_id === s.size_id); if (!k) return <td key={s.size_id} />;
                    const key = `${k.color_id}|${k.size_id}`;
                    return <td key={s.size_id} className="px-1 py-1 text-right"><input className="input h-7 w-16 text-right" type="number" min={0} id={`jwf-out-${k.color_id}-${k.size_id}`} value={qty[key] ?? ''} onChange={(e) => setQty({ ...qty, [key]: e.target.value })} /></td>; })}
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FabricInwardModal({ dcId, onClose, onDone }: { dcId: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const warehouses = useLookup('warehouses');
  const [dc, setDc] = useState<any>(null);
  const [out, setOut] = useState<Record<number, { g: string; r: string; reason: string }>>({});
  const [rolls, setRolls] = useState<Record<number, { u: string; b: string; w: string }>>({});
  const [h, setH] = useState({ inward_date: today(), warehouse_id: '', party_dc_no: '', remarks: '', to_fg: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/job-work/fabric-dcs/${dcId}`).then((r) => setDc(r.data.data)).catch((e) => toast(errMsg(e), 'error')); }, [dcId]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/job-work/fabric-dcs/${dcId}/inward`, {
        ...h, warehouse_id: h.warehouse_id ? Number(h.warehouse_id) : null, party_dc_no: h.party_dc_no || null, remarks: h.remarks || null,
        outputs: Object.entries(out).filter(([, v]) => num(v.g) + num(v.r) > 0).map(([id, v]) => ({ line_id: Number(id), good_qty: num(v.g), reject_qty: num(v.r), reject_reason: v.reason || null })),
        rolls: Object.entries(rolls).filter(([, v]) => num(v.u) + num(v.b) + num(v.w) > 0).map(([id, v]) => ({ fabric_issue_id: Number(id), consumed_kg: num(v.u), returned_kg: num(v.b), waste_kg: num(v.w) })),
      });
      const d = r.data.data;
      toast(`Inward ${d.inward_no}: ${d.good} good PCS${d.fg_receipt_id ? ' into FG stock' : ''} · fabric used ${d.used_kg} KG, back ${d.returned_kg} KG, waste ${d.waste_kg} KG`); onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  if (!dc) return <Modal open onClose={onClose} title="Fabric inward"><p className="text-sm text-slate-500">Loading…</p></Modal>;
  return (
    <Modal open onClose={onClose} size="full" title={`Fabric DC inward — ${dc.challan_no} · ${dc.vendor_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} id="jwfi-save" onClick={save}><PackageCheck size={13} className="mr-1 inline" />Save inward</Button></>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Input label="Inward date" type="date" value={h.inward_date} onChange={(e) => setH({ ...h, inward_date: e.target.value })} />
        <Select label="Receiving store" value={h.warehouse_id} onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} placeholder="— store —" options={toOptions(warehouses.data)} />
        <Input label="Party DC no" value={h.party_dc_no} onChange={(e) => setH({ ...h, party_dc_no: e.target.value })} />
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
        <label className="mt-6 flex items-center gap-2 text-xs"><input type="checkbox" checked={h.to_fg} onChange={(e) => setH({ ...h, to_fg: e.target.checked })} />Good garments into FG stock</label>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div>
          <h4 className="mb-1 text-sm font-bold text-slate-700">Garments received</h4>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Colour</th><th className="px-2 py-1 text-left">Size</th><th className="px-2 py-1 text-right">Expected</th>
              <th className="px-2 py-1 text-right">Pending</th><th className="px-2 py-1 text-right">Good</th><th className="px-2 py-1 text-right">Reject</th><th className="px-2 py-1 text-left">Reject reason</th></tr></thead>
            <tbody>{dc.lines.map((l: any) => { const v = out[l.id] ?? { g: '', r: '', reason: '' }; return (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-2 py-1">{l.color_name}</td><td className="px-2 py-1 font-semibold">{l.size_code}</td><td className="px-2 py-1 text-right">{l.qty}</td>
                <td className="px-2 py-1 text-right font-semibold">{num(l.pending_qty)}</td>
                <td className="px-2 py-1 text-right"><input className="input h-7 w-16 text-right" type="number" min={0} id={`jwfi-good-${l.id}`} disabled={!num(l.pending_qty)} value={v.g} onChange={(e) => setOut({ ...out, [l.id]: { ...v, g: e.target.value } })} /></td>
                <td className="px-2 py-1 text-right"><input className="input h-7 w-16 text-right" type="number" min={0} disabled={!num(l.pending_qty)} value={v.r} onChange={(e) => setOut({ ...out, [l.id]: { ...v, r: e.target.value } })} /></td>
                <td className="px-2 py-1"><input className="input h-7 w-32" disabled={!num(v.r)} value={v.reason} onChange={(e) => setOut({ ...out, [l.id]: { ...v, reason: e.target.value } })} /></td>
              </tr>); })}</tbody>
          </table>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-bold text-slate-700">Fabric reconciliation per roll (KG)</h4>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Roll</th><th className="px-2 py-1 text-right">Issued</th><th className="px-2 py-1 text-right">With contractor</th>
              <th className="px-2 py-1 text-right">Used</th><th className="px-2 py-1 text-right">Returned</th><th className="px-2 py-1 text-right">Waste</th></tr></thead>
            <tbody>{dc.rolls.map((r: any) => { const v = rolls[r.id] ?? { u: '', b: '', w: '' }; const bad = num(v.u) + num(v.b) + num(v.w) > num(r.balance_kg) + 0.0005; return (
              <tr key={r.id} className={`border-t border-slate-100 ${bad ? 'bg-red-50' : ''}`}>
                <td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1 text-right">{num(r.issue_kg)}</td><td className="px-2 py-1 text-right font-semibold">{num(r.balance_kg)}</td>
                {(['u', 'b', 'w'] as const).map((k) => <td key={k} className="px-1 py-1 text-right"><input className="input h-7 w-20 text-right" type="number" min={0} step="0.001" id={`jwfi-roll-${r.id}-${k}`}
                  disabled={!(num(r.balance_kg) > 0)} value={v[k]} onChange={(e) => setRolls({ ...rolls, [r.id]: { ...v, [k]: e.target.value } })} /></td>)}
              </tr>); })}</tbody>
          </table>
          <p className="mt-1 text-[11px] text-slate-500">Returned KG goes back to the same roll in our stock; used + returned + waste must not exceed what the contractor holds.</p>
        </div>
      </div>
      {dc.inwards.length > 0 && <p className="mt-3 text-xs text-slate-500">Earlier inwards: {dc.inwards.map((i: any) => `${i.inward_no} (${i.good_qty} good, used ${num(i.consumed_kg)} KG)`).join(', ')}</p>}
    </Modal>
  );
}

// ───────────────────────────── Contractor stock & dashboard ─────────────────────────────
export function JobWorkDashboardPage() {
  const toast = useToast();
  const contractors = useContractors();
  const [vendor, setVendor] = useState('');
  const [dash, setDash] = useState<any>(null);
  const [stock, setStock] = useState<any>(null);
  useEffect(() => { api.get('/job-work/dashboard').then((r) => setDash(r.data.data)).catch((e) => toast(errMsg(e), 'error')); }, []);
  useEffect(() => { api.get('/job-work/contractor-stock', { params: { vendor_id: vendor || undefined } }).then((r) => setStock(r.data.data)).catch((e) => toast(errMsg(e), 'error')); }, [vendor]);
  const l90 = dash?.last_90_days;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Job Work Dashboard</h1>
        <p className="text-sm text-slate-500">Material with contractors (kept apart from company stock), overdue DCs, process-wise pending inward, QC pending and unbilled inwards</p>
      </div>
      {dash && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6" id="jw-dash-tiles">
          <Tile label="Overdue DCs" value={dash.overdue.length} tone="red" />
          <Tile label="Pending at contractors (PCS)" value={fmtNumber(dash.by_process.reduce((a: number, p: any) => a + num(p.pending_pcs), 0))} tone="amber" />
          <Tile label="Rework open (PCS)" value={fmtNumber(dash.by_process.reduce((a: number, p: any) => a + num(p.rework_pcs), 0))} tone="violet" />
          <Tile label="QC pending inwards" value={dash.qc_pending.length} tone="blue" />
          <Tile label="Unbilled inwards" value={`${dash.unbilled.inwards} · ${fmtNumber(dash.unbilled.pcs)} PCS`} tone="slate" />
          <Tile label="Loss % (90 days)" value={l90?.issued ? `${(((l90.reject + l90.shortage + l90.loss) / Math.max(1, l90.issued - l90.returned)) * 100).toFixed(2)}%` : '—'} tone="slate" />
        </div>
      )}
      {dash && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card title="Process-wise pending inward">
            <DataTable data={dash.by_process} emptyTitle="Nothing pending" columns={[
              { key: 'stage_name', header: 'Process' }, { key: 'dcs', header: 'DCs', align: 'right' as const },
              { key: 'pending_pcs', header: 'Pending PCS', align: 'right' as const, render: (r: any) => fmtNumber(r.pending_pcs) },
              { key: 'rework_pcs', header: 'Rework open', align: 'right' as const, render: (r: any) => fmtNumber(r.rework_pcs) }]} />
          </Card>
          <Card title="Overdue DCs (past expected return)">
            <DataTable data={dash.overdue} emptyTitle="No overdue DC" columns={[
              { key: 'challan_no', header: 'DC', render: (r: any) => <span className="font-mono">{r.challan_no}</span> }, { key: 'vendor_name', header: 'Contractor' },
              { key: 'stage_name', header: 'Process' }, { key: 'expected_return', header: 'Expected', render: (r: any) => fmtDate(r.expected_return) },
              { key: 'days_late', header: 'Days late', align: 'right' as const, render: (r: any) => <b className="text-red-600">{r.days_late}</b> },
              { key: 'pending_pcs', header: 'Pending', align: 'right' as const }]} />
          </Card>
        </div>
      )}
      <Card title="Contractor stock">
        <div className="p-3"><Select label="Contractor" className="w-72" value={vendor} placeholder="All contractors" onChange={(e) => setVendor(e.target.value)} options={contractors.map((c) => ({ value: c.id, label: c.label }))} /></div>
        {stock && (
          <>
            <DataTable data={stock.contractors} rowKey={(r: any) => r.vendor_id} emptyTitle="Nothing with contractors" columns={[
              { key: 'vendor_name', header: 'Contractor' }, { key: 'dcs', header: 'Open DCs', align: 'right' as const },
              { key: 'pcs', header: 'PCS held', align: 'right' as const, render: (r: any) => <b>{fmtNumber(r.pcs)}</b> },
              { key: 'rework_pcs', header: 'of which rework', align: 'right' as const },
              { key: 'overdue_pcs', header: 'Overdue PCS', align: 'right' as const, render: (r: any) => r.overdue_pcs ? <b className="text-red-600">{fmtNumber(r.overdue_pcs)}</b> : '—' },
              { key: 'kg', header: 'Fabric KG held', align: 'right' as const, render: (r: any) => r.kg ? <b>{r.kg}</b> : '—' }]} />
            <details className="p-3 text-xs">
              <summary className="cursor-pointer font-semibold text-slate-600">Line detail ({stock.lines.length} bundle lines · {stock.fabric.length} rolls)</summary>
              <table className="mt-2 w-full">
                <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Contractor</th><th className="px-2 py-1 text-left">DC</th><th className="px-2 py-1 text-left">Process</th>
                  <th className="px-2 py-1 text-left">Job</th><th className="px-2 py-1 text-left">Bundle / colour / size</th><th className="px-2 py-1 text-right">Pending</th><th className="px-2 py-1 text-right">Days out</th></tr></thead>
                <tbody>{stock.lines.map((l: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100"><td className="px-2 py-1">{l.vendor_name}</td><td className="px-2 py-1 font-mono">{l.challan_no}</td><td className="px-2 py-1">{l.stage_name}</td>
                    <td className="px-2 py-1">{l.io_no}{l.jw_no ? ` · ${l.jw_no}` : ''}</td><td className="px-2 py-1">{l.bundle_no ?? ''} {l.color_name} {l.size_code}</td>
                    <td className="px-2 py-1 text-right font-semibold">{l.pending_qty}</td><td className="px-2 py-1 text-right">{l.days_out}</td></tr>
                ))}
                {stock.fabric.map((f: any, i: number) => (
                  <tr key={`f${i}`} className="border-t border-slate-100 bg-violet-50/40"><td className="px-2 py-1">{f.vendor_name}</td><td className="px-2 py-1 font-mono">{f.challan_no}</td><td className="px-2 py-1">Fabric</td>
                    <td className="px-2 py-1">{f.jw_no ?? ''}</td><td className="px-2 py-1">Roll {f.roll_no}</td><td className="px-2 py-1 text-right font-semibold">{num(f.balance_kg)} KG</td><td /></tr>
                ))}</tbody>
              </table>
            </details>
          </>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone: string }) {
  const c: Record<string, string> = { red: 'border-red-100 bg-red-50 text-red-800', amber: 'border-amber-100 bg-amber-50 text-amber-800', violet: 'border-violet-100 bg-violet-50 text-violet-800',
    blue: 'border-blue-100 bg-blue-50 text-blue-800', slate: 'border-slate-200 bg-slate-50 text-slate-700' };
  return <div className={`rounded-xl border px-3 py-2 ${c[tone]}`}><div className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{label}</div><div className="text-lg font-bold">{value}</div></div>;
}

// ───────────────────────────── Process rate master ─────────────────────────────
export function JobWorkRatesPage() {
  const toast = useToast();
  const contractors = useContractors();
  const stages = useLookup('process-stages');
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = () => api.get('/job-work/rates').then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, []);
  const save = async () => {
    try {
      const b = { ...edit, vendor_id: Number(edit.vendor_id), stage_id: Number(edit.stage_id), style_id: edit.style_id ? Number(edit.style_id) : null, buyer_id: edit.buyer_id ? Number(edit.buyer_id) : null,
        rate: num(edit.rate), effective_from: edit.effective_from || null, effective_to: edit.effective_to || null, remarks: edit.remarks || null };
      if (edit.id) await api.put(`/job-work/rates/${edit.id}`, b); else await api.post('/job-work/rates', b);
      toast('Rate saved'); setEdit(null); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const blank = { vendor_id: '', stage_id: '', style_id: '', buyer_id: '', uom: 'PCS', rate: '', effective_from: today(), effective_to: '', is_active: true, remarks: '' };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Job Work Rates</h1>
          <p className="text-sm text-slate-500">Rate by contractor + process, optionally per style or buyer, with effective dates — the most specific valid rate fills the order / DC</p>
        </div>
        <Button id="jwr-new" onClick={() => setEdit(blank)}><Plus size={14} className="mr-1 inline" />New rate</Button>
      </div>
      <Card>
        <DataTable data={rows} emptyTitle="No rates" columns={[
          { key: 'vendor_name', header: 'Contractor' }, { key: 'stage_name', header: 'Process' },
          { key: 'style_code', header: 'Style', render: (r: any) => r.style_code ?? <span className="text-slate-400">any</span> },
          { key: 'buyer_name', header: 'Buyer', render: (r: any) => r.buyer_name ?? <span className="text-slate-400">any</span> },
          { key: 'rate', header: 'Rate', align: 'right' as const, render: (r: any) => <b>{money(r.rate)} / {r.uom}</b> },
          { key: 'effective_from', header: 'Valid', render: (r: any) => `${r.effective_from ? fmtDate(r.effective_from) : '…'} → ${r.effective_to ? fmtDate(r.effective_to) : '…'}` },
          { key: 'is_active', header: 'Active', render: (r: any) => (r.is_active ? <Badge tone="green">Yes</Badge> : <Badge tone="slate">No</Badge>) },
          { key: 'act', header: '', render: (r: any) => <Button size="sm" variant="ghost" onClick={() => setEdit({ ...r, style_id: r.style_id ?? '', buyer_id: r.buyer_id ?? '', effective_from: r.effective_from ? String(r.effective_from).slice(0, 10) : '', effective_to: r.effective_to ? String(r.effective_to).slice(0, 10) : '', is_active: !!r.is_active, remarks: r.remarks ?? '' })}>Edit</Button> },
        ]} />
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? 'Edit rate' : 'New rate'}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button id="jwr-save" disabled={!edit.vendor_id || !edit.stage_id || edit.rate === ''} onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Contractor" required value={edit.vendor_id} onChange={(e) => setEdit({ ...edit, vendor_id: e.target.value })} placeholder="— choose —" options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
            <Select label="Process" required value={edit.stage_id} onChange={(e) => setEdit({ ...edit, stage_id: e.target.value })} placeholder="— choose —" options={toOptions(stages.data)} />
            <Select label="Style (optional)" value={edit.style_id} onChange={(e) => setEdit({ ...edit, style_id: e.target.value })} placeholder="Any style" options={toOptions(styles.data)} />
            <Select label="Buyer (optional)" value={edit.buyer_id} onChange={(e) => setEdit({ ...edit, buyer_id: e.target.value })} placeholder="Any buyer" options={toOptions(buyers.data)} />
            <Input label="Rate (₹)" type="number" min={0} step="0.01" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} />
            <Select label="Per" value={edit.uom} onChange={(e) => setEdit({ ...edit, uom: e.target.value })} options={['PCS', 'KG', 'M', 'BUNDLE', 'CARTON'].map((u) => ({ value: u, label: u }))} />
            <Input label="Effective from" type="date" value={edit.effective_from} onChange={(e) => setEdit({ ...edit, effective_from: e.target.value })} />
            <Input label="Effective to" type="date" value={edit.effective_to} onChange={(e) => setEdit({ ...edit, effective_to: e.target.value })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />Active</label>
            <Input label="Remarks" value={edit.remarks} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ───────────────────────────── Contractor accounts: statement, credit notes, payments ─────────────────────────────
export function ContractorAccountsPage() {
  const toast = useToast();
  const contractors = useContractors();
  const [tab, setTab] = useState('statement');
  const [vendor, setVendor] = useState('');
  const [range, setRange] = useState({ from: `${today().slice(0, 4)}-04-01`, to: today() });
  const [st, setSt] = useState<any>(null);
  const [cns, setCns] = useState<any[]>([]);
  const [pays, setPays] = useState<any[]>([]);
  const [adding, setAdding] = useState<'cn' | 'pay' | null>(null);
  const [f, setF] = useState<any>({});
  const [cancel, setCancel] = useState<any>(null);
  const [reason, setReason] = useState('');
  const load = () => {
    const p = { vendor_id: vendor || undefined };
    api.get('/contractor-credit-notes', { params: p }).then((r) => setCns(r.data.data || [])).catch(() => setCns([]));
    api.get('/contractor-payments', { params: p }).then((r) => setPays(r.data.data || [])).catch(() => setPays([]));
    if (vendor) api.get('/job-work/contractor-statement', { params: { vendor_id: vendor, ...range } }).then((r) => setSt(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
    else setSt(null);
  };
  useEffect(load, [vendor, range.from, range.to]);
  const save = async () => {
    try {
      if (adding === 'cn') { const r = await api.post('/contractor-credit-notes', { ...f, vendor_id: Number(f.vendor_id), amount: num(f.amount), tax: num(f.tax), jw_order_id: null, io_no: f.io_no || null }); toast(`Credit note ${r.data.data.cn_no} saved`); }
      else { const r = await api.post('/contractor-payments', { ...f, vendor_id: Number(f.vendor_id), amount: num(f.amount), bill_id: null, reference_no: f.reference_no || null, remarks: f.remarks || null }); toast(`Payment ${r.data.data.payment_no} saved`); }
      setAdding(null); setVendor(String(f.vendor_id)); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const doCancel = async () => {
    try { await api.post(`/${cancel.kind === 'cn' ? 'contractor-credit-notes' : 'contractor-payments'}/${cancel.id}/cancel`, { reason }); toast('Cancelled'); setCancel(null); load(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Contractor Accounts</h1>
          <p className="text-sm text-slate-500">Statement: opening + bills + credit notes − advances − debit notes − payments = closing (what we owe the contractor)</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" id="ca-new-cn" onClick={() => { setF({ vendor_id: vendor, cn_date: today(), amount: '', tax: '', reason: '', io_no: '' }); setAdding('cn'); }}><Plus size={14} className="mr-1 inline" />Credit note</Button>
          <Button id="ca-new-pay" onClick={() => { setF({ vendor_id: vendor, payment_date: today(), amount: '', mode: 'BANK', reference_no: '', remarks: '' }); setAdding('pay'); }}><Plus size={14} className="mr-1 inline" />Payment</Button>
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Select label="Contractor" id="ca-vendor" className="w-72" value={vendor} placeholder="— choose —" onChange={(e) => setVendor(e.target.value)} options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
          <Input label="From" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <Input label="To" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
        <div className="px-3">
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'statement', label: 'Statement' }, { key: 'cn', label: 'Credit notes', count: cns.length }, { key: 'pay', label: 'Payments', count: pays.length }]} />
        </div>
        {tab === 'statement' && (!vendor ? <p className="p-4 text-sm text-slate-500">Choose a contractor.</p> : st && (
          <div className="p-3" id="ca-statement">
            <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-7">
              <Tile label="Opening" value={money(st.opening)} tone="slate" /><Tile label="Bills" value={money(st.bills)} tone="blue" /><Tile label="Credit notes" value={money(st.credits)} tone="blue" />
              <Tile label="Advances" value={money(st.advances)} tone="amber" /><Tile label="Debit notes" value={money(st.debits)} tone="amber" /><Tile label="Payments" value={money(st.payments)} tone="amber" />
              <Tile label="Closing" value={money(st.closing)} tone={st.closing >= 0 ? 'violet' : 'red'} />
            </div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Type</th><th className="px-2 py-1 text-left">Ref</th><th className="px-2 py-1 text-left">Note</th>
                <th className="px-2 py-1 text-right">We owe (+)</th><th className="px-2 py-1 text-right">Paid / recovered (−)</th><th className="px-2 py-1 text-right">Balance</th></tr></thead>
              <tbody>
                <tr className="border-t border-slate-100 font-semibold"><td className="px-2 py-1" colSpan={6}>Opening balance</td><td className="px-2 py-1 text-right">{money(st.opening)}</td></tr>
                {st.lines.map((l: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100"><td className="px-2 py-1">{fmtDate(l.date)}</td><td className="px-2 py-1">{l.type}</td><td className="px-2 py-1 font-mono">{l.ref}</td><td className="px-2 py-1 text-slate-500">{l.note ?? ''}</td>
                    <td className="px-2 py-1 text-right">{l.credit ? money(l.credit) : ''}</td><td className="px-2 py-1 text-right">{l.debit ? money(l.debit) : ''}</td><td className="px-2 py-1 text-right font-semibold">{money(l.balance)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {tab === 'cn' && <DataTable data={cns} emptyTitle="No credit notes" columns={[
          { key: 'cn_no', header: 'CN no', render: (r: any) => <span className="font-mono">{r.cn_no}</span> }, { key: 'cn_date', header: 'Date', render: (r: any) => fmtDate(r.cn_date) },
          { key: 'vendor_name', header: 'Contractor' }, { key: 'reason', header: 'Reason' }, { key: 'io_no', header: 'Job', render: (r: any) => r.io_no ?? r.jw_no ?? '—' },
          { key: 'amount', header: 'Amount', align: 'right' as const, render: (r: any) => money(num(r.amount) + num(r.tax)) },
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={r.status === 'OPEN' ? 'green' : 'red'}>{r.status}</Badge> },
          { key: 'act', header: '', render: (r: any) => r.status === 'OPEN' ? <Button size="sm" variant="ghost" onClick={() => { setReason(''); setCancel({ ...r, kind: 'cn' }); }}><Ban size={12} /></Button> : null }]} />}
        {tab === 'pay' && <DataTable data={pays} emptyTitle="No payments" columns={[
          { key: 'payment_no', header: 'Payment no', render: (r: any) => <span className="font-mono">{r.payment_no}</span> }, { key: 'payment_date', header: 'Date', render: (r: any) => fmtDate(r.payment_date) },
          { key: 'vendor_name', header: 'Contractor' }, { key: 'mode', header: 'Mode' }, { key: 'reference_no', header: 'Ref' }, { key: 'bill_no', header: 'Bill', render: (r: any) => r.bill_no ?? '—' },
          { key: 'amount', header: 'Amount', align: 'right' as const, render: (r: any) => money(r.amount) },
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={r.status === 'POSTED' ? 'green' : 'red'}>{r.status}</Badge> },
          { key: 'act', header: '', render: (r: any) => r.status === 'POSTED' ? <Button size="sm" variant="ghost" onClick={() => { setReason(''); setCancel({ ...r, kind: 'pay' }); }}><Ban size={12} /></Button> : null }]} />}
      </Card>
      {adding && (
        <Modal open onClose={() => setAdding(null)} title={adding === 'cn' ? 'New contractor credit note' : 'New contractor payment'}
          footer={<><Button variant="secondary" onClick={() => setAdding(null)}>Cancel</Button>
            <Button id="ca-save" disabled={!f.vendor_id || !(num(f.amount) > 0) || (adding === 'cn' && (f.reason ?? '').trim().length < 3)} onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Contractor" required className="col-span-2" value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })} placeholder="— choose —" options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
            {adding === 'cn' ? (<>
              <Input label="Date" type="date" value={f.cn_date} onChange={(e) => setF({ ...f, cn_date: e.target.value })} />
              <Input label="Job (optional)" value={f.io_no} onChange={(e) => setF({ ...f, io_no: e.target.value })} />
              <Input label="Amount (₹)" type="number" min={0} step="0.01" id="ca-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
              <Input label="Tax (₹)" type="number" min={0} step="0.01" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })} />
              <Textarea label="Reason" required className="col-span-2" id="ca-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </>) : (<>
              <Input label="Date" type="date" value={f.payment_date} onChange={(e) => setF({ ...f, payment_date: e.target.value })} />
              <Input label="Amount (₹)" type="number" min={0} step="0.01" id="ca-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
              <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['BANK', 'CASH', 'UPI', 'CHEQUE'].map((v) => ({ value: v, label: v }))} />
              <Input label="Ref / cheque no" value={f.reference_no} onChange={(e) => setF({ ...f, reference_no: e.target.value })} />
              <Textarea label="Remarks" className="col-span-2" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
            </>)}
          </div>
        </Modal>
      )}
      {cancel && (
        <Modal open onClose={() => setCancel(null)} size="sm" title={`Cancel ${cancel.cn_no ?? cancel.payment_no}`}
          footer={<><Button variant="secondary" onClick={() => setCancel(null)}>Back</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={doCancel}>Cancel it</Button></>}>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}
