import { useState, useEffect, useMemo } from 'react';
import { Card, Badge, Button, Input, Select, DataTable, Textarea, Modal, FormSection } from '../../components/ui';
import { PackageCheck, Ban, Eye } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { JobSelect } from '../../components/JobSelect';

/**
 * FG Receipt — the gate into packing (client call 16-Oct-2026). Finished garments are received into the FG store
 * here, size-wise (good / reject per colour × size of the order). Only PCS received here can be packed (packing
 * order, polybag / individual piece entry, cartons), and the FG store stock / value follows the receipts.
 *   In-house    PCS that finished ironing (Final QC when required) on the job's bundles
 *   Job work    garments back from job work (fabric sent out) — up to the order qty + allowance
 *   Return / Surplus  returned or extra pieces of the order's colours / sizes
 */
type Cell = { part_name: string | null; color_id: number; size_id: number; sku_id: number | null; order_qty: number; on_order: boolean; received: number; packed: number; on_hand: number; in_house_ready: number };
type JobInfo = { io_no: string; so_no: string | null; parts: (string | null)[]; styles: { id: number; style_code: string; style_name: string }[]; style_id: number | null;
  colors: { id: number; color_name: string }[]; sizes: { id: number; size_code: string }[]; cells: Cell[]; fg_mode: boolean };

const SOURCES = [
  { value: 'IN_HOUSE', label: 'In-house (finished bundles)' },
  { value: 'JOB_WORK', label: 'Job work (garments back)' },
  { value: 'RETURN', label: 'Return' },
  { value: 'SURPLUS', label: 'Surplus / extra pieces' },
];
const srcLabel = (v: string) => SOURCES.find((x) => x.value === v)?.label.split(' (')[0] ?? v;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');

export function FgReceiptsPage() {
  const toast = useToast();
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [view, setView] = useState<any>(null);
  const [cancelOf, setCancelOf] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchReceipts = () => {
    setLoading(true);
    api.get('/fg-receipts').then((r) => setReceipts(r.data.data || [])).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  };
  useEffect(fetchReceipts, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (r: any) => api.get(`/fg-receipts/${r.id}`).then((x) => setView(x.data.data)).catch((e) => toast(errMsg(e), 'error'));
  const doCancel = async () => {
    setBusy(true);
    try {
      await api.post(`/fg-receipts/${cancelOf.id}/cancel`, { reason });
      toast(`${cancelOf.receipt_no} cancelled — its PCS are out of the FG store`);
      setCancelOf(null); setReason(''); setView(null); fetchReceipts();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Finished Goods Receipts</h1>
          <p className="text-sm text-slate-500">
            Receive finished garments into the FG store, size-wise. <b>Only PCS received here can be packed</b> (packing order, polybag / piece entry, cartons);
            the FG store stock and value follow these receipts.
          </p>
        </div>
        <Button id="fg-new" onClick={() => setShowNew(true)}><PackageCheck size={14} className="mr-1 inline" />Receive Finished Goods</Button>
      </div>

      <Card>
        <DataTable
          data={receipts}
          loading={loading}
          onRowClick={open}
          columns={[
            { key: 'receipt_no', header: 'Receipt No', sortable: true, render: (r: any) => <span className="tabular-nums text-xs font-semibold text-brand-700">{r.receipt_no}</span> },
            { key: 'receipt_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.receipt_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => r.io_no ? <Badge color="indigo">{r.io_no}</Badge> : <span className="text-slate-300">—</span> },
            { key: 'style_code', header: 'Style', render: (r: any) => <span className="font-medium">{r.style_code}</span> },
            { key: 'source_type', header: 'Source', render: (r: any) => <Badge color="slate">{srcLabel(r.source_type ?? r.source_stage)}</Badge> },
            { key: 'warehouse_name', header: 'FG store' },
            { key: 'total_qty', header: 'Good (PCS)', align: 'right' as const, render: (r: any) => <span className="font-semibold text-emerald-700">{fmtNumber(r.total_qty)}</span> },
            { key: 'total_reject', header: 'Reject (PCS)', align: 'right' as const, render: (r: any) => <span className="font-semibold text-red-600">{fmtNumber(r.total_reject)}</span> },
            { key: 'status', header: 'Status', render: (r: any) => (
              <span className="flex items-center gap-1">
                <Badge color={r.status === 'CANCELLED' ? 'red' : r.status === 'RECEIVED' ? 'emerald' : 'slate'}>{r.status}</Badge>
                {!Number(r.fg_posted) && r.status !== 'CANCELLED' && <span className="text-[10px] text-slate-400" title="Entered before the FG store gate — history only">history</span>}
              </span>
            ) },
          ]}
        />
      </Card>

      {showNew && <NewReceiptModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); fetchReceipts(); }} />}

      {view && (
        <Modal open onClose={() => setView(null)} size="lg" icon={<Eye size={16} />} title={`FG receipt ${view.receipt_no}`}
          subtitle={`${view.io_no} · ${view.style_code ?? ''} · ${srcLabel(view.source_type ?? view.source_stage)} · ${view.warehouse_name ?? ''} · ${fmtDate(view.receipt_date)}`}
          footerStart={view.status === 'CANCELLED' ? <span className="text-xs text-red-600">Cancelled: {view.cancel_reason}</span> : null}
          footer={<>
            {view.status !== 'CANCELLED' && Number(view.fg_posted) ? <Button variant="secondary" id="fg-cancel" onClick={() => setCancelOf(view)}><Ban size={13} className="mr-1 inline" />Cancel receipt</Button> : null}
            <Button variant="secondary" onClick={() => setView(null)}>Close</Button>
          </>}>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-2 text-left">Colour</th><th className="px-2 py-2 text-left">Size</th><th className="px-2 py-2 text-right">Good</th><th className="px-2 py-2 text-right">Reject</th></tr></thead>
            <tbody>
              {view.lines.map((l: any) => (
                <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1.5">{l.color_name}</td><td className="px-2 py-1.5">{l.size_code}</td>
                  <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{fmtNumber(l.good_qty)}</td><td className="px-2 py-1.5 text-right text-red-600">{fmtNumber(l.reject_qty)}</td></tr>
              ))}
            </tbody>
          </table>
          {view.bundles?.length > 0 && <p className="mt-2 text-[11px] text-slate-500">From bundles: {view.bundles.map((b: any) => `${b.bundle_no} (${b.good_qty}${b.reject_qty ? ` + ${b.reject_qty} rej` : ''})`).join(', ')}</p>}
        </Modal>
      )}

      {cancelOf && (
        <Modal open onClose={() => setCancelOf(null)} size="sm" icon={<Ban size={16} />} title={`Cancel ${cancelOf.receipt_no}`}
          subtitle="Its PCS leave the FG store — only while none of them is packed or bagged"
          footer={<>
            <Button variant="secondary" onClick={() => setCancelOf(null)}>Back</Button>
            <Button id="fg-cancel-ok" loading={busy} disabled={reason.trim().length < 3} onClick={doCancel}>Cancel receipt</Button>
          </>}>
          <Textarea id="fg-cancel-reason" label="Reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}

function NewReceiptModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [head, setHead] = useState({ receipt_date: today(), io_no: '', style_id: '', source_type: 'IN_HOUSE', warehouse_id: '', source_ref: '', remarks: '' });
  const [info, setInfo] = useState<JobInfo | null>(null);
  const [qty, setQty] = useState<Record<string, { good: string; reject: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/lookups/warehouses').then((r) => {
      const list = r.data.data || [];
      setWarehouses(list);
      const fg = list.find((w: any) => w.warehouse_type === 'FINISHED_GOODS');
      if (fg) setHead((h) => ({ ...h, warehouse_id: String(fg.id) }));
    }).catch(() => setWarehouses([]));
  }, []);

  const loadJob = (io: string, styleId?: string) => {
    if (!io) { setInfo(null); return; }
    api.get('/fg-receipts/job-info', { params: { io_no: io, style_id: styleId || undefined } })
      .then((r) => {
        const d: JobInfo = r.data.data;
        setInfo(d); setQty({});
        setHead((h) => ({ ...h, style_id: d.style_id ? String(d.style_id) : '' }));
      })
      .catch((e) => { toast(errMsg(e), 'error'); setInfo(null); });
  };

  // a job with TOP and BOTTOM is received part by part (a set's parts are paired only at packing)
  const cellKey = (p: string | null, c: number, s: number) => (p ? `${p}|${c}:${s}` : `${c}:${s}`);
  const cellOf = (p: string | null, c: number, s: number) => info?.cells.find((x) => (x.part_name ?? null) === p && x.color_id === c && x.size_id === s);
  const parts: (string | null)[] = info?.parts?.length ? info.parts : [null];
  const canTake = (cl: Cell) => (head.source_type === 'IN_HOUSE' ? cl.in_house_ready : head.source_type === 'SURPLUS' ? null : Math.max(cl.order_qty - cl.received, 0));
  // only the order's colours / sizes (in-house also those cut on the job's bundles)
  const visible = (cl?: Cell) => !!cl && (cl.on_order || (head.source_type === 'IN_HOUSE' && cl.in_house_ready > 0));
  const colorsOf = (p: string | null) => (info?.colors ?? []).filter((c) => (info?.cells ?? []).some((x) => (x.part_name ?? null) === p && x.color_id === Number(c.id) && visible(x)));
  const colors = useMemo(() => (info?.colors ?? []).filter((c) => (info?.cells ?? []).some((x) => x.color_id === Number(c.id) && visible(x))), [info, head.source_type]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizes = useMemo(() => (info?.sizes ?? []).filter((s) => (info?.cells ?? []).some((x) => x.size_id === Number(s.id) && visible(x))), [info, head.source_type]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = Object.values(qty).reduce((a, v) => ({ good: a.good + (Number(v.good) || 0), reject: a.reject + (Number(v.reject) || 0) }), { good: 0, reject: 0 });

  const save = async () => {
    const lines = Object.entries(qty).map(([k, v]) => {
      const [p, cs] = k.includes('|') ? k.split('|') : [null, k];
      const [color_id, size_id] = cs.split(':').map(Number);
      return { part_name: p, color_id, size_id, good_qty: Number(v.good) || 0, reject_qty: Number(v.reject) || 0 };
    }).filter((l) => l.good_qty > 0 || l.reject_qty > 0);
    if (!head.io_no || !head.style_id) { toast('Pick the job and style', 'warning'); return; }
    if (!head.warehouse_id) { toast('Pick the FG store', 'warning'); return; }
    if (!lines.length) { toast('Enter good / reject PCS in the size grid', 'warning'); return; }
    setSaving(true);
    try {
      const r = await api.post('/fg-receipts', { ...head, style_id: Number(head.style_id), warehouse_id: Number(head.warehouse_id), source_ref: head.source_ref || null, remarks: head.remarks || null, lines });
      toast(r.data.message ?? 'FG receipt posted');
      onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="Receive Finished Goods" size="xl" icon={<PackageCheck size={16} />}
      subtitle="Pick the job — style, colours and sizes come from the order. Enter good / reject PCS size-wise."
      footerStart={<span className="text-sm"><b className="text-emerald-700">{fmtNumber(totals.good)}</b> good · <b className="text-red-600">{fmtNumber(totals.reject)}</b> reject PCS</span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="fg-save" onClick={save} loading={saving}>Post into FG store</Button>
      </>}>
      <FormSection cols={3}>
        <Input label="Receipt date" type="date" required value={head.receipt_date} onChange={(e) => setHead({ ...head, receipt_date: e.target.value })} />
        <JobSelect id="fg-job" label="Job (I/O no)" required value={head.io_no}
          onPick={(j) => { const io = j?.job_no ?? ''; setHead({ ...head, io_no: io, style_id: '' }); loadJob(io); }} />
        <Select id="fg-style" label="Style" required value={head.style_id} placeholder={info ? 'Select style…' : 'Pick the job first'}
          onChange={(e) => { setHead({ ...head, style_id: e.target.value }); loadJob(head.io_no, e.target.value); }}
          options={(info?.styles ?? []).map((s) => ({ value: String(s.id), label: `${s.style_code} — ${s.style_name}` }))} />
        <Select id="fg-source" label="Source" required value={head.source_type} onChange={(e) => { setHead({ ...head, source_type: e.target.value }); setQty({}); }} options={SOURCES} />
        <Select id="fg-store" label="FG store" required value={head.warehouse_id} placeholder="Select store…" onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })}
          options={warehouses.map((w) => ({ value: String(w.id), label: `${w.label}${w.warehouse_type === 'FINISHED_GOODS' ? '' : ` (${w.warehouse_type})`}` }))} />
        <Input label="Reference (DC / inspection no)" value={head.source_ref} onChange={(e) => setHead({ ...head, source_ref: e.target.value })} />
      </FormSection>

      {info && head.style_id && (
        <div className="mt-3 overflow-x-auto">
          {colors.length === 0 ? (
            <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {head.source_type === 'IN_HOUSE' ? 'No finished PCS of this job / style are waiting to be received (nothing has finished ironing yet).' : 'The order has no colours / sizes for this style.'}
            </p>
          ) : (
            <div id="fg-grid">
            {parts.map((part) => colorsOf(part).length > 0 && (
            <div key={part ?? 'all'} data-fg-part={part ?? ''} className="mb-3">
            {part && <div className="mb-1 rounded bg-indigo-50 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-indigo-800">{part}</div>}
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-left">Colour</th>
                  {sizes.map((s) => <th key={s.id} className="px-2 py-2 text-center">{s.size_code}</th>)}
                  <th className="px-2 py-2 text-right">Good</th><th className="px-2 py-2 text-right">Reject</th>
                </tr>
              </thead>
              <tbody>
                {colorsOf(part).map((c) => {
                  const rowGood = sizes.reduce((a, s) => a + (Number(qty[cellKey(part, Number(c.id), Number(s.id))]?.good) || 0), 0);
                  const rowRej = sizes.reduce((a, s) => a + (Number(qty[cellKey(part, Number(c.id), Number(s.id))]?.reject) || 0), 0);
                  return (
                    <tr key={c.id} className="border-t border-slate-100 align-top" data-fg-color={c.id}>
                      <td className="px-2 py-2 font-semibold text-slate-800">{c.color_name}</td>
                      {sizes.map((s) => {
                        const cl = cellOf(part, Number(c.id), Number(s.id));
                        if (!visible(cl)) return <td key={s.id} className="px-2 py-2 text-center text-slate-300">—</td>;
                        const k = cellKey(part, Number(c.id), Number(s.id));
                        const v = qty[k] ?? { good: '', reject: '' };
                        const cap = canTake(cl!);
                        const over = cap != null && (Number(v.good) || 0) + (head.source_type === 'IN_HOUSE' ? Number(v.reject) || 0 : 0) > cap;
                        // in-house: a size with nothing finished on the job's bundles cannot be received yet
                        if (head.source_type === 'IN_HOUSE' && !cl!.in_house_ready) {
                          return <td key={s.id} className="px-2 py-2 text-center text-[10px] text-slate-400" data-fg-cell={k} title="Nothing of this colour / size has finished ironing yet">ready 0<br />in FG {cl!.on_hand}</td>;
                        }
                        return (
                          <td key={s.id} className="px-1.5 py-1.5 text-center" data-fg-cell={k}>
                            <div className="inline-flex flex-col items-end gap-1">
                              <label className="flex items-center gap-1 text-[10px] text-emerald-700">G
                                <input type="number" min={0} placeholder="good" value={v.good} data-fg-good={k}
                                  onChange={(e) => setQty({ ...qty, [k]: { ...v, good: e.target.value } })}
                                  className={`input h-7 w-20 text-right text-xs ${over ? 'border-red-400 bg-red-50' : ''}`} />
                              </label>
                              <label className="flex items-center gap-1 text-[10px] text-red-600">R
                                <input type="number" min={0} placeholder="reject" value={v.reject} data-fg-reject={k}
                                  onChange={(e) => setQty({ ...qty, [k]: { ...v, reject: e.target.value } })}
                                  className="input h-7 w-20 text-right text-xs" />
                              </label>
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-500" title={`Order ${cl!.order_qty} · received ${cl!.received} · packed ${cl!.packed} · in store ${cl!.on_hand}`}>
                              {cap == null ? `ord ${cl!.order_qty}` : head.source_type === 'IN_HOUSE' ? `ready ${cap}` : `bal ${cap}`} · in FG {cl!.on_hand}
                            </div>
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-right font-semibold text-emerald-700">{fmtNumber(rowGood)}</td>
                      <td className="px-2 py-2 text-right text-red-600">{fmtNumber(rowRej)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            {head.source_type === 'IN_HOUSE'
              ? '"ready" = PCS that finished ironing (Final QC when required) on the job\'s bundles and are not yet in the FG store. Good + reject cannot exceed it.'
              : head.source_type === 'SURPLUS' ? 'Surplus pieces are not limited by the order quantity.'
                : '"bal" = order quantity not yet received (a small allowance over the order is accepted).'}
            {' '}"in FG" = PCS of the job in the FG store now (received − packed).
          </p>
        </div>
      )}
      <Textarea label="Remarks" rows={2} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
    </Modal>
  );
}
