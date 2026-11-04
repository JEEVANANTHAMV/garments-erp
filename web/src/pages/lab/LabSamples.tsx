import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, QrCode } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Textarea, Checkbox, Modal, LoadingBlock, ErrorState, SearchInput, useDebounced, FormSection } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDateTime } from '../../lib/format';
import { LabStatus, KV, AttachmentList, FilePick, errMsg, label, opts, num, openBlob, uploadLabFile, newKey, SAMPLE_TYPES, SAMPLE_UOMS } from './labShared';

/** Sample inward + identification (spec §4.2): register, inward form, sample detail with QR label and custody ledger. */

const SAMPLE_STATUSES = ['RECEIVED', 'ISSUED', 'PARTIALLY_CONSUMED', 'CONSUMED', 'RETAINED', 'DISPOSED'];

export function LabSamplesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const [status, setStatus] = useState('');
  const [scan, setScan] = useState('');
  const toast = useToast();
  const list = useQuery({ queryKey: ['lab-samples', dq, status], queryFn: async () => (await http.get<{ data: any[] }>('/lab/samples', { q: dq || undefined, status: status || undefined })).data });
  const lookupQr = async () => {
    try { const d = (await http.get<{ data: any }>(`/lab/samples/by-qr/${encodeURIComponent(scan.trim())}`)).data; nav(`/lab/samples/${d.id}`); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <div>
      <PageHeader title="Lab samples" breadcrumb={['Lab']} subtitle="Sample inward, balance and custody ledger"
        actions={can('LAB.UPDATE') && <Button id="lab-sample-inward" onClick={() => nav('/lab/samples/inward')}>Sample inward</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <SearchInput className="w-64" value={q} onChange={setQ} placeholder="Sample ID, request, style, lot…" />
        <Select label="Status" className="w-48" placeholder="All" options={opts(SAMPLE_STATUSES)} value={status} onChange={(e) => setStatus(e.target.value)} />
        <div className="ml-auto flex items-end gap-2">
          <Input label="Scan QR" className="w-64" placeholder="LAB:S:…" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void lookupQr(); }} />
          <Button variant="secondary" onClick={() => void lookupQr()}><QrCode size={15} />Find</Button>
        </div>
      </div>
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : (
          <table className="w-full" id="lab-sample-list">
            <thead><tr><th className="th">Sample ID</th><th className="th">Request</th><th className="th">Style / colour</th><th className="th">Type</th><th className="th">Received</th>
              <th className="th text-right">Received</th><th className="th text-right">Available</th><th className="th text-right">With trials</th><th className="th text-right">Consumed</th><th className="th text-right">Retained</th><th className="th">Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).length === 0 && <tr><td colSpan={11} className="td text-center text-ink-muted">No samples</td></tr>}
              {(list.data ?? []).map((s) => (
                <tr key={s.id} className="row-hover">
                  <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/samples/${s.id}`}>{s.sample_no}</Link></td>
                  <td className="td"><Link className="hover:underline" to={`/lab/requests/${s.request_id}`}>{s.request_no}</Link></td>
                  <td className="td">{s.style_code ?? '—'}{s.color_name ? ` · ${s.color_name}` : ''}</td><td className="td">{label(s.sample_type)}</td><td className="td">{fmtDateTime(s.received_at)}</td>
                  <td className="td text-right tabular-nums">{num(s.received_qty, 3)} {s.uom}</td><td className="td text-right tabular-nums">{num(s.balance.available, 3)}</td>
                  <td className="td text-right tabular-nums">{num(s.balance.outstanding, 3)}</td><td className="td text-right tabular-nums">{num(s.balance.consumed, 3)}</td>
                  <td className="td text-right tabular-nums">{num(s.balance.retained_balance, 3)}</td><td className="td"><LabStatus value={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ================================================================ inward */
export function LabSampleInwardPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const colors = useLookup('colors');
  const [requestId, setRequestId] = useState(sp.get('request') ?? '');
  const open = useQuery({ queryKey: ['lab-requests-open-inward'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/requests',
    { status: 'SUBMITTED,SAMPLE_RECEIVED,IN_TESTING,PENDING_LAB_REVIEW,PENDING_QA_APPROVAL,RETEST_REQUIRED,REJECTED', pageSize: 500 })).data });
  const req = useQuery({ queryKey: ['lab-request', Number(requestId)], enabled: !!requestId, queryFn: async () => (await http.get<{ data: any }>(`/lab/requests/${requestId}`)).data });
  const now = new Date(); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [v, setV] = useState<Record<string, any>>({ request_item_id: '', received_at: local, sample_type: 'GARMENT', received_qty: '', uom: 'PCS', sample_weight_g: '', length_cm: '', width_cm: '',
    color_id: '', lot_reference: '', sample_condition: 'Good', handed_over_by: '', storage_location: '', retention_until: '', reuse_allowed: true, remarks: '' });
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k: string, x: unknown) => setV((o) => ({ ...o, [k]: x }));
  useEffect(() => { const r = req.data; if (r) setV((o) => ({ ...o, color_id: o.color_id || (r.color_id ? String(r.color_id) : ''), lot_reference: o.lot_reference || (r.fabric_lot ?? '') })); }, [req.data]);
  const pickItem = (id: string) => {
    const it = req.data?.items.find((i: any) => String(i.id) === id);
    setV((o) => ({ ...o, request_item_id: id, ...(it ? { sample_type: it.sample_type, uom: it.uom, received_qty: o.received_qty || String(Math.max(0, Number(it.requested_qty) - Number(it.received_qty))) } : {}) }));
  };
  const save = async () => {
    if (!requestId) { setErr('Choose the lab request'); return; }
    if (!(Number(v.received_qty) > 0)) { setErr('Received quantity must be greater than zero'); return; }
    setBusy(true); setErr('');
    try {
      const dims: Record<string, number> = {};
      if (v.length_cm) dims.length_cm = Number(v.length_cm); if (v.width_cm) dims.width_cm = Number(v.width_cm);
      const res = await http.post<{ data: any }>(`/lab/requests/${requestId}/samples`, {
        request_item_id: v.request_item_id || null, received_at: v.received_at || null, sample_type: v.sample_type, received_qty: v.received_qty, uom: v.uom,
        sample_weight_g: v.sample_weight_g || null, dimensions: Object.keys(dims).length ? dims : null, color_id: v.color_id || null, lot_reference: v.lot_reference || null,
        sample_condition: v.sample_condition || null, handed_over_by: v.handed_over_by || null, storage_location: v.storage_location || null,
        retention_until: v.retention_until || null, reuse_allowed: v.reuse_allowed, remarks: v.remarks || null,
      });
      if (photo) { try { await uploadLabFile(photo, { sample_id: res.data.id, attachment_type: 'SAMPLE_PHOTO', caption: 'Sample at inward' }); } catch (e) { toast(`Photo not saved: ${errMsg(e)}`, 'error'); } }
      void qc.invalidateQueries({ queryKey: ['lab-request', Number(requestId)] });
      toast(`Sample ${res.data.sample_no} received`);
      nav(`/lab/samples/${res.data.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const reqOpts = (open.data ?? []).map((r) => ({ value: r.id, label: `${r.request_no} · ${r.buyer_name ?? '—'} · ${r.style_code ?? r.development_ref ?? '—'}` }));
  if (requestId && req.data && !reqOpts.some((o) => String(o.value) === requestId)) reqOpts.unshift({ value: req.data.id, label: `${req.data.request_no} (${label(req.data.status)})` });
  return (
    <div>
      <PageHeader title="Sample inward" breadcrumb={['Lab', 'Samples']} subtitle="Receive, inspect, weigh / count and label the sample — partial and repeated inward allowed"
        actions={<><Button variant="secondary" onClick={() => nav(-1)}>Back</Button><Button id="lab-inward-save" loading={busy} onClick={() => void save()}>Receive sample</Button></>} />
      {err && <div id="lab-inward-error" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-small text-red-700">{err}</div>}
      <div className="card p-4">
        <FormSection title="Request">
          <Select id="lab-inward-request" label="Lab request" required className="sm:col-span-2" placeholder="— Select request —" options={reqOpts} value={requestId} onChange={(e) => { setRequestId(e.target.value); set('request_item_id', ''); }} />
          <Select label="Requirement line" placeholder="—" className="sm:col-span-2" value={v.request_item_id} onChange={(e) => pickItem(e.target.value)}
            options={(req.data?.items ?? []).map((i: any) => ({ value: i.id, label: `${label(i.sample_type)} · ${num(i.requested_qty, 3)} ${i.uom} requested · ${num(i.received_qty, 3)} received` }))} />
        </FormSection>
        <FormSection title="Sample">
          <Input label="Received at" type="datetime-local" value={v.received_at} onChange={(e) => set('received_at', e.target.value)} />
          <Select label="Sample type" options={opts(SAMPLE_TYPES)} value={v.sample_type} onChange={(e) => set('sample_type', e.target.value)} />
          <Input id="lab-inward-qty" label="Received quantity" required type="number" min="0" step="any" value={v.received_qty} onChange={(e) => set('received_qty', e.target.value)} />
          <Select label="UOM" options={SAMPLE_UOMS.map((x) => ({ value: x, label: x }))} value={v.uom} onChange={(e) => set('uom', e.target.value)} />
          <Input label="Sample weight (g)" type="number" step="any" value={v.sample_weight_g} onChange={(e) => set('sample_weight_g', e.target.value)} />
          <Input label="Length (cm)" type="number" step="any" value={v.length_cm} onChange={(e) => set('length_cm', e.target.value)} />
          <Input label="Width (cm)" type="number" step="any" value={v.width_cm} onChange={(e) => set('width_cm', e.target.value)} />
          <Select label="Colour" placeholder="—" options={toOptions(colors.data)} value={v.color_id} onChange={(e) => set('color_id', e.target.value)} />
          <Input label="Lot / dye lot" value={v.lot_reference} onChange={(e) => set('lot_reference', e.target.value)} />
          <Input label="Condition" value={v.sample_condition} onChange={(e) => set('sample_condition', e.target.value)} />
        </FormSection>
        <FormSection title="Custody">
          <Input label="Handed over by" value={v.handed_over_by} onChange={(e) => set('handed_over_by', e.target.value)} />
          <Input label="Storage location / rack / bin" value={v.storage_location} onChange={(e) => set('storage_location', e.target.value)} />
          <Input label="Retain until" type="date" value={v.retention_until} onChange={(e) => set('retention_until', e.target.value)} />
          <div className="flex items-end pb-2"><Checkbox label="Can be used in more than one trial" checked={v.reuse_allowed} onChange={(x) => set('reuse_allowed', x)} /></div>
          <Textarea label="Remarks" className="sm:col-span-2" value={v.remarks} onChange={(e) => set('remarks', e.target.value)} />
          <div className="flex items-end gap-2 sm:col-span-2"><FilePick label={photo ? 'Change photo' : 'Sample photo (optional)'} accept=".png,.jpg,.jpeg,.webp" onPick={setPhoto} />{photo && <span className="text-small">{photo.name}</span>}</div>
        </FormSection>
      </div>
    </div>
  );
}

/* ================================================================ detail */
type Move = '' | 'issue' | 'consume' | 'return' | 'retain' | 'dispose';

export function LabSampleDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lab-sample', id], queryFn: async () => (await http.get<{ data: any }>(`/lab/samples/${id}`)).data });
  const [move, setMove] = useState<Move>('');
  const s = q.data;
  if (q.isLoading) return <div className="card"><LoadingBlock /></div>;
  if (q.error || !s) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const b = s.balance;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lab-sample', id] }); void qc.invalidateQueries({ queryKey: ['lab-samples'] }); void qc.invalidateQueries({ queryKey: ['lab-request', Number(s.request_id)] }); };
  return (
    <div>
      <PageHeader title={<span className="flex items-center gap-2">{s.sample_no} <LabStatus value={s.status} /></span>} breadcrumb={['Lab', 'Samples']}
        subtitle={<>Request <Link className="text-brand-700 hover:underline" to={`/lab/requests/${s.request_id}`}>{s.request_no}</Link> · {s.buyer_name ?? '—'} · {s.style_code ?? '—'}{s.color_name ? ` · ${s.color_name}` : ''}</>}
        actions={<>
          <Button id="lab-sample-label" variant="secondary" onClick={() => void openBlob(`/lab/samples/${id}/label`).catch((e) => toast(errMsg(e), 'error'))}><Printer size={15} />QR label</Button>
          {can('LAB.UPDATE') && <>
            <Button id="lab-sample-issue" onClick={() => setMove('issue')} disabled={!(b.available > 0)}>Issue to trial</Button>
            <Button variant="secondary" onClick={() => setMove('consume')} disabled={!(b.outstanding > 0)}>Consume</Button>
            <Button variant="secondary" onClick={() => setMove('return')} disabled={!(b.outstanding > 0)}>Return</Button>
            <Button variant="secondary" onClick={() => setMove('retain')} disabled={!(b.available > 0)}>Retain</Button>
          </>}
          {can('LAB.APPROVE') && <Button variant="danger" onClick={() => setMove('dispose')} disabled={!(b.available > 0 || b.retained_balance > 0)}>Dispose</Button>}
        </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" id="lab-sample-balance">
        {[['Received', b.inward], ['Available', b.available], ['With trials', b.outstanding], ['Consumed', b.consumed], ['Retained', b.retained_balance], ['Disposed', b.disposed]].map(([k, x]) => (
          <div key={k as string} className="card p-3"><p className="text-small text-ink-secondary">{k}</p><p className="text-title font-semibold tabular-nums">{num(x, 3)} <span className="text-small text-ink-muted">{s.uom}</span></p></div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Sample" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
            <KV k="Type" v={label(s.sample_type)} /><KV k="Received" v={`${fmtDateTime(s.received_at)} by ${s.received_by_name ?? '—'}`} /><KV k="Handed over by" v={s.handed_over_by} />
            <KV k="Weight" v={s.sample_weight_g ? `${num(s.sample_weight_g, 2)} g` : null} /><KV k="Dimensions" v={s.dimensions ? Object.entries(s.dimensions).map(([k, x]) => `${label(k)} ${x}`).join(' · ') : null} />
            <KV k="Lot" v={s.lot_reference} /><KV k="Condition" v={s.sample_condition} /><KV k="Storage" v={s.storage_location} /><KV k="Retain until" v={s.retention_until ? String(s.retention_until).slice(0, 10) : null} />
            <KV k="Reuse" v={Number(s.reuse_allowed) ? 'Several trials' : 'Single trial'} /><KV k="Remarks" v={s.remarks} />
          </div>
        </Card>
        <Card title="Photos & files" actions={can('LAB.UPDATE') && <FilePick label="Add photo" accept=".png,.jpg,.jpeg,.webp,.pdf"
          onPick={async (f) => { try { await uploadLabFile(f, { sample_id: id, attachment_type: 'SAMPLE_PHOTO' }); refresh(); toast('Photo attached'); } catch (e) { toast(errMsg(e), 'error'); } }} />}>
          <div className="px-4 py-2"><AttachmentList rows={s.attachments} /></div>
        </Card>
        <Card title="Custody ledger" className="lg:col-span-3">
          <div className="overflow-x-auto"><table className="w-full" id="lab-sample-ledger">
            <thead><tr><th className="th">When</th><th className="th">Movement</th><th className="th text-right">Qty</th><th className="th">Trial</th><th className="th">By</th><th className="th">Received by</th><th className="th">Reason</th></tr></thead>
            <tbody>{s.ledger.map((l: any) => (
              <tr key={l.id}><td className="td">{fmtDateTime(l.txn_at)}</td><td className="td">{label(l.txn_type)}{l.from_bucket === 'RETAINED' ? ' (retained)' : ''}</td>
                <td className="td text-right tabular-nums">{num(l.quantity, 3)} {l.uom}</td><td className="td">{l.trial_id ? <Link className="text-brand-700 hover:underline" to={`/lab/trials/${l.trial_id}`}>{l.trial_no}</Link> : '—'}</td>
                <td className="td">{l.by_name ?? '—'}</td><td className="td">{l.received_by ?? '—'}</td><td className="td">{l.reason ?? ''}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
        {b.by_trial.length > 0 && (
          <Card title="By trial" className="lg:col-span-3">
            <table className="w-full"><thead><tr><th className="th">Trial</th><th className="th text-right">Issued</th><th className="th text-right">Returned</th><th className="th text-right">Consumed</th><th className="th text-right">Outstanding</th></tr></thead>
              <tbody>{b.by_trial.map((x: any) => (
                <tr key={x.trial_id}><td className="td">{s.trials.find((t: any) => t.id === x.trial_id)?.trial_no ?? `#${x.trial_id}`}</td><td className="td text-right">{num(x.issued, 3)}</td>
                  <td className="td text-right">{num(x.returned, 3)}</td><td className="td text-right">{num(x.consumed, 3)}</td><td className="td text-right font-semibold">{num(x.outstanding, 3)}</td></tr>
              ))}</tbody></table>
          </Card>
        )}
      </div>
      {move && <MoveModal s={s} move={move} onClose={() => setMove('')} onDone={() => { refresh(); toast('Ledger updated'); }} />}
    </div>
  );
}

function MoveModal({ s, move, onClose, onDone }: { s: any; move: Exclude<Move, ''>; onClose: () => void; onDone: () => void }) {
  const b = s.balance;
  const trials = move === 'issue' ? s.trials.filter((t: any) => !['APPROVED', 'REJECTED', 'RETEST_REQUIRED'].includes(t.status))
    : s.trials.filter((t: any) => b.by_trial.some((x: any) => x.trial_id === t.id && x.outstanding > 0));
  const [v, setV] = useState({ trial_id: trials.length === 1 ? String(trials[0].id) : '', quantity: '', reason: '', received_by: '', from: 'AVAILABLE', storage_location: '', retention_until: '' });
  const [key] = useState(newKey());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const max = move === 'issue' || move === 'retain' ? b.available : move === 'dispose' ? (v.from === 'RETAINED' ? b.retained_balance : b.available)
    : (b.by_trial.find((x: any) => String(x.trial_id) === v.trial_id)?.outstanding ?? 0);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = { quantity: v.quantity, idempotency_key: key, reason: v.reason || null };
      if (['issue', 'consume', 'return'].includes(move)) { body.trial_id = v.trial_id || null; body.received_by = v.received_by || null; }
      if (move === 'dispose') body.from = v.from;
      if (move === 'retain') { body.storage_location = v.storage_location || null; body.retention_until = v.retention_until || null; }
      await http.post(`/lab/samples/${s.id}/${move}`, body); onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`${label(move)} — ${s.sample_no}`} subtitle={`Up to ${num(max, 3)} ${s.uom}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="lab-move-save" variant={move === 'dispose' ? 'danger' : 'primary'} loading={busy} onClick={() => void go()}>{label(move)}</Button></>}>
      <div className="space-y-3">
        {['issue', 'consume', 'return'].includes(move) && (
          <Select id="lab-move-trial" label="Trial" required placeholder={trials.length ? '— Select trial —' : 'No eligible trial'} value={v.trial_id} onChange={(e) => setV({ ...v, trial_id: e.target.value })}
            options={trials.map((t: any) => ({ value: t.id, label: `${t.trial_no} (${label(t.status)})` }))} />
        )}
        {move === 'dispose' && <Select label="From" options={[{ value: 'AVAILABLE', label: 'Available stock' }, { value: 'RETAINED', label: 'Retained sample' }]} value={v.from} onChange={(e) => setV({ ...v, from: e.target.value })} />}
        <Input id="lab-move-qty" label={`Quantity (${s.uom})`} required type="number" min="0" step="any" value={v.quantity} onChange={(e) => setV({ ...v, quantity: e.target.value })} />
        {move === 'issue' && <Input label="Received by" value={v.received_by} onChange={(e) => setV({ ...v, received_by: e.target.value })} />}
        {move === 'retain' && <><Input label="Retained location" value={v.storage_location} onChange={(e) => setV({ ...v, storage_location: e.target.value })} />
          <Input label="Retain until" type="date" value={v.retention_until} onChange={(e) => setV({ ...v, retention_until: e.target.value })} /></>}
        <Textarea label={move === 'dispose' ? 'Reason (required)' : 'Reason / remarks'} required={move === 'dispose'} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
        {err && <p className="text-small text-red-600" id="lab-move-error">{err}</p>}
      </div>
    </Modal>
  );
}
