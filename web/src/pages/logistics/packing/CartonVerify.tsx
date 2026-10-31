import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Lock, Printer, Send, RotateCcw, Ban, Undo2 } from 'lucide-react';
import { PageHeader, Card, Button, Input, EmptyState, Badge } from '../../../components/ui';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { fmtDateTime, fmtNumber } from '../../../lib/format';
import { PackingNav, PkStatus, Stat, errMsg, n, TableHead, ReasonModal, printCartonLabel } from './packingShared';

/**
 * Screen D — scan the carton barcode → contents, capacity and polybag variance → verify (weights) → seal → label → post.
 * Sealed cartons are locked; reopen / reverse need PACKING.APPROVE and a reason, void needs a reason.
 */
export function CartonVerifyPage() {
  const [sp, setSp] = useSearchParams();
  const [code, setCode] = useState(sp.get('code') ?? '');
  const [c, setC] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [w, setW] = useState({ net: '', gross: '', seal: '', labels: false });
  const [reason, setReason] = useState<null | 'reopen' | 'void' | 'reverse'>(null);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const scanRef = useRef<HTMLInputElement>(null);

  const load = async (v: string) => {
    if (!v.trim()) return;
    setErr(''); setBusy('scan');
    try {
      const r = await http.get<{ data: any }>(`/packing/scan/${encodeURIComponent(v.trim())}`);
      setC(r.data); setSp({ code: r.data.carton_no }, { replace: true });
      setW({ net: r.data.net_weight_kg ?? '', gross: r.data.gross_weight_kg ?? '', seal: r.data.seal_no ?? '', labels: false });
    } catch (e) { setC(null); setErr(errMsg(e)); } finally { setBusy(''); }
  };
  useEffect(() => { if (sp.get('code')) load(sp.get('code')!); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const act = async (key: string, fn: () => Promise<{ data: any }>, msg: string) => {
    setBusy(key); setErr('');
    try {
      const r = await fn();
      const next = r.data?.carton ?? r.data;
      if (next?.carton_no) setC(next); else await load(c.carton_no);
      toast(msg); qc.invalidateQueries({ queryKey: ['packing-order'] }); qc.invalidateQueries({ queryKey: ['packing-orders'] });
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); }
  };
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
  const editable = c && ['DRAFT', 'OPEN'].includes(c.carton_status) && !n(c.is_posted);

  return (
    <div>
      <PageHeader title="Carton verification / seal" breadcrumb={['Logistics', 'Packing']}
        subtitle="Scan the carton barcode to see exactly what is inside, check capacity and polybags, verify, seal, print the label and post." />
      <PackingNav active="/logistics/packing/verify" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <Card title="Scan">
          <div className="space-y-3 p-4">
            <Input id="carton-scan" ref={scanRef} label="Carton barcode / carton no" value={code} autoFocus placeholder="Scan, then Enter"
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(code); }} />
            <div className="flex justify-end"><Button variant="secondary" loading={busy === 'scan'} onClick={() => load(code)}>Show carton</Button></div>
            {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" id="verify-error">{err}</div>}
            {c && editable && can('PACKING.UPDATE') && <>
              <div className="border-t border-slate-100 pt-3 text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">Verify</div>
              <div className="grid grid-cols-2 gap-3">
                <Input id="verify-net" label="Net kg" inputMode="decimal" value={w.net} onChange={(e) => setW({ ...w, net: e.target.value })} />
                <Input id="verify-gross" label="Gross kg" inputMode="decimal" value={w.gross} onChange={(e) => setW({ ...w, gross: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-[12.5px] text-slate-600"><input type="checkbox" checked={w.labels} onChange={(e) => setW({ ...w, labels: e.target.checked })} />Buyer labels / shipping marks checked</label>
              <div className="flex justify-end"><Button id="verify-carton" loading={busy === 'verify'} onClick={() => act('verify', () => http.post(`/packing/cartons/${c.id}/verify`, { net_weight_kg: num(w.net), gross_weight_kg: num(w.gross), labels_ok: w.labels }), `Carton ${c.carton_no} verified`)}><CheckCircle2 size={15} />Verify</Button></div>
            </>}
            {c?.carton_status === 'VERIFIED' && can('PACKING.UPDATE') && <>
              <div className="border-t border-slate-100 pt-3 text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">Seal</div>
              <Input id="seal-no" label="Seal no" value={w.seal} onChange={(e) => setW({ ...w, seal: e.target.value })} />
              <div className="flex justify-end"><Button id="seal-carton" loading={busy === 'seal'} onClick={() => act('seal', () => http.post(`/packing/cartons/${c.id}/seal`, { seal_no: w.seal || null }), `Carton ${c.carton_no} sealed`)}><Lock size={15} />Seal</Button></div>
            </>}
          </div>
        </Card>
        {!c ? <EmptyState title="Scan a carton" message="The carton barcode is its carton number (Code 128)." /> : (
          <div id="carton-panel"><Card title={<span className="tabular-nums text-[15px] font-semibold">{c.carton_no}</span>}
            subtitle={<>{c.carton_seq} of {c.carton_count} · <Link className="text-brand-700 hover:underline" to={`/logistics/packing/orders/${c.packing_id}`}>{c.pack_no}</Link> · {c.io_no} · {c.style_code}{c.buyer_po_no ? ` · PO ${c.buyer_po_no}` : ''} · {c.buyer_name}</>}
            actions={<PkStatus value={c.carton_status} posted={c.is_posted} />}>
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Pieces" value={fmtNumber(c.pieces_total)} hint={`capacity ${c.capacity.standard}`} tone={c.capacity.status === 'OVERPACK' ? 'red' : c.capacity.status === 'PARTIAL' ? 'amber' : 'green'} />
                <Stat label="Capacity check" value={c.capacity.status} hint={c.capacity.diff ? `${c.capacity.diff > 0 ? '+' : ''}${c.capacity.diff} pcs` : 'exact'} />
                <Stat label="Polybags" value={`${c.polybag_qty} / ${c.std_polybag_qty}`} hint={c.polybag_variance ? `variance ${c.polybag_variance > 0 ? '+' : ''}${c.polybag_variance}` : 'as standard'} tone={c.polybag_variance ? 'amber' : undefined} />
                <Stat label="Net / gross kg" value={`${c.net_weight_kg ?? '—'} / ${c.gross_weight_kg ?? '—'}`} hint={c.carton_trim_name ?? 'no carton type'} />
              </div>
              <div>
                <TableHead title="Contents (size × colour)" />
                <table className="w-full text-[12.5px]" id="carton-contents"><thead><tr><th className="th">Colour</th><th className="th">Size</th><th className="th text-right">Pieces</th><th className="th text-right">Polybags</th></tr></thead>
                  <tbody>{c.lines.map((l: any) => <tr key={l.id}><td className="td">{l.color_name}</td><td className="td">{l.size_code}</td><td className="td text-right">{l.qty}</td><td className="td text-right">{l.polybag_qty}</td></tr>)}</tbody>
                  <tfoot><tr className="font-semibold"><td className="td" colSpan={2}>Total</td><td className="td text-right">{c.lines.reduce((a: number, l: any) => a + n(l.qty), 0)}</td><td className="td text-right">{c.lines.reduce((a: number, l: any) => a + n(l.polybag_qty), 0)}</td></tr></tfoot></table>
              </div>
              {c.bundles.length > 0 && <div>
                <TableHead title="Bundles (posted)" />
                <div className="flex flex-wrap gap-1.5">{c.bundles.map((b: any) => <Badge key={b.bundle_id} tone="blue">{b.bundle_no} · {b.color_name}/{b.size_code} · {b.qty}</Badge>)}</div>
              </div>}
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                {['VERIFIED', 'SEALED'].includes(c.carton_status) && n(c.is_posted) === 0 && c.carton_status !== 'VOID' && can('PACKING.APPROVE') && <Button variant="secondary" onClick={() => setReason('reopen')}><RotateCcw size={15} />Reopen</Button>}
                {n(c.is_posted) === 1 && can('PACKING.APPROVE') && c.carton_status !== 'DISPATCHED' && <Button variant="secondary" onClick={() => setReason('reverse')}><Undo2 size={15} />Reverse post</Button>}
                {c.carton_status !== 'VOID' && c.carton_status !== 'DISPATCHED' && (can('PACKING.APPROVE') || (editable && can('PACKING.UPDATE'))) && <Button variant="secondary" onClick={() => setReason('void')}><Ban size={15} />Void</Button>}
                {c.carton_status !== 'VOID' && <Button variant="secondary" id="print-label" onClick={async () => { if (!(await printCartonLabel(c.id))) toast('Allow pop-ups to print the label', 'warning'); }}><Printer size={15} />Print label</Button>}
                {['VERIFIED', 'SEALED'].includes(c.carton_status) && !n(c.is_posted) && can('PACKING.UPDATE') && <Button id="post-carton" loading={busy === 'post'} onClick={() => act('post', () => http.post(`/packing/cartons/${c.id}/post`), `Carton ${c.carton_no} posted — packaging stock deducted`)}><Send size={15} />Post</Button>}
              </div>
              <div>
                <TableHead title="History" />
                <ul className="space-y-1 text-[12px] text-slate-600" id="carton-history">{c.events.map((e: any) => (
                  <li key={e.id}><span className="text-slate-400">{fmtDateTime(e.created_at)}</span> · <b>{e.event_type}</b>{e.from_status && e.to_status && e.from_status !== e.to_status ? ` ${e.from_status} → ${e.to_status}` : ''}{e.reason ? ` — ${e.reason}` : ''}</li>
                ))}</ul>
              </div>
            </div>
          </Card></div>
        )}
      </div>
      <ReasonModal open={!!reason} danger={reason === 'void'}
        title={reason === 'reopen' ? `Reopen carton ${c?.carton_no ?? ''}` : reason === 'reverse' ? `Reverse posting of ${c?.carton_no ?? ''}` : `Void carton ${c?.carton_no ?? ''}`}
        subtitle={reason === 'void' ? 'The carton number is never reused. A posted carton is reversed first (stock back, bundles un-packed).'
          : reason === 'reverse' ? 'Packaging goes back to stock and the bundles are un-packed; the carton stays verified / sealed, unposted.'
          : 'Back to OPEN for changes. A posted carton is reversed first.'}
        confirm={reason === 'reopen' ? 'Reopen' : reason === 'reverse' ? 'Reverse' : 'Void carton'} busy={!!busy}
        onClose={() => setReason(null)}
        onSubmit={(r) => { const k = reason!; setReason(null); act(k, () => http.post(`/packing/cartons/${c.id}/${k}`, { reason: r }), `Carton ${c.carton_no}: ${k} done`); }} />
    </div>
  );
}
