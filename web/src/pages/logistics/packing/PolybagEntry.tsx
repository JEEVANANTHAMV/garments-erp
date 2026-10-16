import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader, Card, Button, Input, Select, LoadingBlock, EmptyState } from '../../../components/ui';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { fmtDateTime, fmtNumber } from '../../../lib/format';
import { PackingNav, PkStatus, OrderPicker, useOrder, usePackingMeta, errMsg, n, TableHead, ReasonModal } from './packingShared';

/**
 * Screen B — Individual piece / polybag entry.
 * Scan a bundle barcode (or pick a bundle) → job / style / colour / size fill from the bundle → pieces + polybags used.
 * Blocks: wrong job, bundle on hold / closed, nothing finished / QC pending, more than the bundle still holds, duplicate bagging.
 * INDIVIDUAL_PIECE mode: garments carry no piece barcode in this system, so a scan bags one polybag
 * (rule pieces-per-polybag) from the scanned bundle; repeated scans are limited by the bundle quantity.
 * FG store packing (PACKING_FROM_FG_RECEIPT, client call 16-Oct-2026): only PCS received on an FG receipt can be
 * bagged — the list shows the FG store per colour / size and "Bag" takes them (job-work garments have no bundle);
 * a bundle scan still works and is limited by that bundle's PCS in the store.
 */
export function PolybagEntryPage() {
  const [sp, setSp] = useSearchParams();
  const orderId = sp.get('order') ? Number(sp.get('order')) : null;
  const order = useOrder(orderId);
  const meta = usePackingMeta();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [pieces, setPieces] = useState('');
  const [bags, setBags] = useState('');
  const [trim, setTrim] = useState('');
  const [operator, setOperator] = useState(() => { try { return localStorage.getItem('pk-operator') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(null);
  const [err, setErr] = useState('');
  const [voiding, setVoiding] = useState<any>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const o = order.data;
  const individual = o?.packing_mode === 'INDIVIDUAL_PIECE';
  const ppp = Math.max(n(o?.rule?.pieces_per_polybag), 1);
  const bundles = useQuery({ queryKey: ['packing-bundles', orderId], enabled: !!orderId, queryFn: async () => (await http.get<{ data: any[] }>(`/packing/orders/${orderId}/bundles`)).data });
  const fgStore = !!bundles.data?.[0]?.fg_store;
  const entries = useQuery({ queryKey: ['packing-polybags', orderId], enabled: !!orderId, queryFn: async () => (await http.get<{ data: any[] }>(`/packing/orders/${orderId}/polybags`)).data });
  const refresh = () => { ['packing-bundles', 'packing-polybags', 'packing-order'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };

  const submit = async (ref: { barcode?: string; bundle_id?: number; color_id?: number; size_id?: number }) => {
    setErr(''); setBusy(true);
    try {
      try { localStorage.setItem('pk-operator', operator); } catch { /* ignore */ }
      const r = await http.post<{ data: any }>(`/packing/orders/${orderId}/polybags`, {
        ...ref, pieces: pieces ? Number(pieces) : null, polybag_qty: bags ? Number(bags) : null,
        polybag_trim_id: trim ? Number(trim) : null, operator_name: operator || null,
      });
      setLast(r.data); setCode(''); setPieces(''); setBags('');
      toast(`${r.data.bundle_no ? `Bundle ${r.data.bundle_no}` : `${r.data.color_name} / ${r.data.size_code} (FG store)`}: ${r.data.pieces} pcs in ${r.data.polybag_qty} polybag(s)`);
      refresh();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); scanRef.current?.focus(); }
  };

  return (
    <div>
      <PageHeader title="Individual piece / polybag entry" breadcrumb={['Logistics', 'Packing']}
        subtitle="Scan a bundle barcode or pick a bundle; job, style, colour and size fill from the bundle. Bagging does not count as packed until the carton is posted." />
      <PackingNav active="/logistics/packing/polybag" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Card title="Entry">
          <div className="space-y-3 p-4">
            <OrderPicker value={orderId} onChange={(v) => setSp(v ? { order: String(v) } : {})} />
            {o && <div className="rounded-lg bg-surface-muted px-3 py-2 text-[12px] text-slate-600">
              {o.job_no} · {o.style_code}{o.buyer_po_no ? ` · PO ${o.buyer_po_no}` : ''}<br />
              Mode <b>{individual ? 'Individual piece' : 'Bundle / quantity'}</b> · {ppp} pc / polybag · <PkStatus value={o.order_status} />
            </div>}
            {individual && <p className="text-[11.5px] text-slate-500">Pieces are not individually barcoded in this system: each scan bags {ppp} piece(s) from the scanned bundle. The bundle quantity limits repeat scans.</p>}
            <Input id="bundle-scan" ref={scanRef} label="Bundle barcode" value={code} disabled={!o || busy} autoFocus placeholder="Scan or type, then Enter"
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) submit({ barcode: code.trim() }); }} />
            <div className="grid grid-cols-2 gap-3">
              <Input id="bag-pieces" label="Pieces" inputMode="numeric" value={pieces} onChange={(e) => setPieces(e.target.value.replace(/\D/g, ''))} placeholder={individual ? String(ppp) : 'All left in bundle'} />
              <Input id="bag-qty" label="Polybags used" inputMode="numeric" value={bags} onChange={(e) => setBags(e.target.value.replace(/\D/g, ''))}
                placeholder={pieces ? String(Math.ceil(n(pieces) / ppp)) : 'Standard'} hint="Actual; standard = pieces ÷ pieces per bag" />
            </div>
            <Select label="Polybag type" value={trim} onChange={(e) => setTrim(e.target.value)} placeholder={o?.rule?.polybag_trim_id ? 'From rule' : '— Polybag item —'}
              options={(meta.data?.trims ?? []).filter((t) => t.trim_type === 'POLYBAG').map((t) => ({ value: t.id, label: t.trim_name }))} />
            <Input label="Operator" value={operator} onChange={(e) => setOperator(e.target.value)} />
            {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" id="polybag-error">{err}</div>}
            {last && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800" id="polybag-last">
              {last.bundle_no ?? 'FG store'} · {last.color_name} / {last.size_code}: <b>{last.pieces}</b> pcs, <b>{last.polybag_qty}</b> bags (std {last.std_polybags}{last.variance ? `, variance ${last.variance > 0 ? '+' : ''}${last.variance}` : ''})</div>}
            <div className="flex justify-end">
              <Button id="polybag-add" disabled={!o || !code.trim() || !can('PACKING.CREATE')} loading={busy} onClick={() => submit({ barcode: code.trim() })}>Record bagging</Button>
            </div>
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <div className="p-3">
              <TableHead title={fgStore ? 'FG store — ready to bag' : 'Bundles ready to bag'} />
              {fgStore && orderId && !bundles.isLoading ? (
                <>
                  <p className="mb-2 text-[11.5px] text-slate-500">Only PCS received on an <b>FG Receipt</b> can be bagged. "Waiting for FG receipt" = finished (ironed) PCS not yet received into the store.</p>
                  <table className="w-full text-[12.5px]" id="fg-store-pick">
                    <thead><tr><th className="th">Colour / size</th><th className="th text-right">Planned</th><th className="th text-right">In FG store</th><th className="th text-right">Bagged</th><th className="th text-right">Can bag</th><th className="th text-right">Packed</th><th className="th text-right">Waiting for FG receipt</th><th className="th" /></tr></thead>
                    <tbody>{bundles.data!.map((b) => (
                      <tr key={`${b.color_id}:${b.size_id}`} data-fg-row={`${b.color_id}:${b.size_id}`}><td className="td">{b.color_name} / {b.size_code}</td><td className="td text-right">{b.planned}</td><td className="td text-right">{b.in_fg}</td>
                        <td className="td text-right">{b.bagged_open}</td><td className="td text-right font-medium">{b.baggable}</td><td className="td text-right">{b.packed}</td>
                        <td className="td text-right">{b.awaiting_fg ? <span className="text-amber-700">{b.awaiting_fg}</span> : '—'}</td>
                        <td className="td text-right">{b.baggable > 0 && can('PACKING.CREATE') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => submit({ color_id: b.color_id, size_id: b.size_id })}>Bag</Button>}</td></tr>
                    ))}</tbody>
                  </table>
                </>
              ) : !orderId ? <EmptyState title="Pick a packing order" message="Only approved / in-progress orders take entries." /> : bundles.isLoading ? <LoadingBlock rows={3} /> : !bundles.data?.length ? <EmptyState title="No bundles" message="No finished bundles for this order's colours / sizes." /> : (
                <table className="w-full text-[12.5px]" id="bundle-pick">
                  <thead><tr><th className="th">Bundle</th><th className="th">Colour / size</th><th className="th text-right">Ready</th><th className="th text-right">Bagged</th><th className="th text-right">Can bag</th><th className="th text-right">Packed</th><th className="th" /></tr></thead>
                  <tbody>{bundles.data.map((b) => (
                    <tr key={b.id}><td className="td font-mono">{b.bundle_no}</td><td className="td">{b.color_name} / {b.size_code}</td><td className="td text-right">{b.ready}{b.qc_pending ? <span className="ml-1 text-[11px] text-amber-700">QC {b.qc_pending}</span> : null}</td>
                      <td className="td text-right">{b.bagged_open}</td><td className="td text-right font-medium">{b.baggable}</td><td className="td text-right">{b.packed}</td>
                      <td className="td text-right">{b.baggable > 0 && can('PACKING.CREATE') && <Button size="sm" variant="secondary" disabled={busy} onClick={() => submit({ bundle_id: b.id })}>Bag</Button>}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </Card>
          {orderId && <Card>
            <div className="p-3">
              <TableHead title="Entries on this order" />
              {!entries.data?.length ? <p className="text-[12px] text-slate-400">No entries yet.</p> : (
                <table className="w-full text-[12.5px]" id="polybag-entries">
                  <thead><tr><th className="th">Time</th><th className="th">Bundle</th><th className="th">Colour / size</th><th className="th text-right">Pcs</th><th className="th text-right">Bags</th><th className="th text-right">In cartons</th><th className="th">Operator</th><th className="th">Status</th><th className="th" /></tr></thead>
                  <tbody>{entries.data.map((b) => (
                    <tr key={b.id} className={b.status === 'VOID' ? 'opacity-50' : ''}><td className="td">{fmtDateTime(b.created_at)}</td><td className="td font-mono">{b.bundle_no ?? <span className="font-sans text-slate-400">FG store</span>}</td><td className="td">{b.color_name} / {b.size_code}</td>
                      <td className="td text-right">{fmtNumber(b.pieces)}</td><td className="td text-right">{b.polybag_qty}</td><td className="td text-right">{b.cartoned_qty}</td><td className="td">{b.operator_name}</td><td className="td"><PkStatus value={b.status} /></td>
                      <td className="td text-right">{b.status === 'OPEN' && !n(b.cartoned_qty) && can('PACKING.UPDATE') && <button className="text-[12px] text-red-600 hover:underline" onClick={() => setVoiding(b)}>Void</button>}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          </Card>}
        </div>
      </div>
      <ReasonModal open={!!voiding} title={`Void bagging of ${voiding?.bundle_no ?? ''}`} confirm="Void entry" danger onClose={() => setVoiding(null)}
        onSubmit={async (reason) => { try { await http.post(`/packing/polybags/${voiding.id}/void`, { reason }); toast('Entry voided'); setVoiding(null); refresh(); } catch (e) { toast(errMsg(e), 'error'); } }} />
    </div>
  );
}
