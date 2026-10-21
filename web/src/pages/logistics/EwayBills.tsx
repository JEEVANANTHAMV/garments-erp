import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CalendarClock, FilePlus2, Info, Plus, Printer, RefreshCw, Save, Send, Trash2, Truck } from 'lucide-react';
import clsx from 'clsx';
import {
  PageHeader, Card, Button, Input, Select, Textarea, FormSection, EmptyState, LoadingBlock, Tabs, SearchInput, ConfirmDialog, useDebounced,
} from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, fmtDecimal } from '../../lib/format';
import {
  type EwbItem, type EwbMeta, useEwbMeta, EwbStatus, STATUS_TABS, TRANSACTION_TYPES, TRANSPORT_MODES, VEHICLE_TYPES,
  computeTotals, isInterState, itemFromServer, emptyItem, itemToPayload, parseError, printEwayBill, errMsg, n,
} from './ewaybill/ewbShared';
import { ErrorBox, SourcePickerModal, GenerateModal, PartBModal, ExtendModal, CancelModal } from './ewaybill/EwbModals';

/**
 * GST e-way bills (client 21-Oct-2026). Register of every e-way bill, and the editor: a draft made from the document
 * that moves the goods (dispatch / process DC / purchase return / gate outward / stock delivery), edited, then generated
 * on the portal through Masters India — or, in manual mode, generated on the GST portal and its number recorded here.
 * A generated bill is read-only: update the vehicle (Part B), extend or cancel it.
 */

const MANUAL_NOTE = 'Manual mode — generate on the GST portal, record the EWB number here. Switches to the Masters India API when connected.';

function ModeNote({ meta }: { meta?: EwbMeta }) {
  if (!meta) return null;
  if (meta.online) {
    return (
      <div className={clsx('mb-4 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[12.5px]',
        meta.configured ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700')} id="ewb-mode">
        <Info size={15} className="mt-0.5 shrink-0" />
        {meta.configured ? `Online — e-way bills are generated on the GST portal through ${meta.provider_label}.`
          : `${meta.provider_label} is selected but its login is not configured on the server — generating will fail until it is.`}
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-[12.5px] text-sky-800" id="ewb-mode">
      <Info size={15} className="mt-0.5 shrink-0" />{MANUAL_NOTE}
    </div>
  );
}

/* ============================================================
   REGISTER
============================================================ */
export function EwayBillRegisterPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const meta = useEwbMeta();
  const [status, setStatus] = useState('');
  const [flt, setFlt] = useState({ source_type: '', q: '', from: '', to: '' });
  const [picking, setPicking] = useState(false);
  const dq = useDebounced(flt.q);
  const list = useQuery({
    queryKey: ['eway-bills', flt.source_type, dq, flt.from, flt.to],
    queryFn: async () => (await http.get<{ data: any[] }>('/eway-bills', { source_type: flt.source_type, q: dq, from: flt.from, to: flt.to })).data,
  });
  const alerts = useQuery({
    queryKey: ['eway-bills-alerts'],
    queryFn: async () => (await http.get<{ data: { expiring: number; just_expired: number } }>('/eway-bills-alerts')).data,
    refetchInterval: 5 * 60 * 1000,
  });
  const rows = list.data ?? [];
  const shown = status ? rows.filter((r) => r.view_status === status) : rows;
  const counts = useMemo(() => rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.view_status]: (a[r.view_status] ?? 0) + 1 }), {}), [rows]);
  const al = alerts.data;

  return (
    <div>
      <PageHeader title="E-way bills" breadcrumb={['Logistics', 'Shipment & Export']}
        subtitle={meta.data ? `GST e-way bills for goods moved by road / rail / air / ship · ${meta.data.online ? meta.data.provider_label : 'Manual mode'} · needed from ₹${fmtDecimal(meta.data.threshold, 0)}` : 'GST e-way bills'}
        actions={can('EWAY.CREATE') && <Button id="ewb-new" onClick={() => setPicking(true)}><Plus size={15} />New e-way bill</Button>} />
      <ModeNote meta={meta.data} />
      {!!al && (al.expiring > 0 || al.just_expired > 0) && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800" id="ewb-alerts">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            {al.expiring > 0 && <><b>{al.expiring}</b> e-way bill{al.expiring > 1 ? 's' : ''} expire{al.expiring > 1 ? '' : 's'} within 12 hours. </>}
            {al.just_expired > 0 && <><b>{al.just_expired}</b> expired in the last 8 hours — extend while the goods are still moving. </>}
            <button className="font-semibold underline" onClick={() => setStatus(al.expiring > 0 ? 'ACTIVE' : 'EXPIRED')}>Show them</button>
          </span>
        </div>
      )}
      <Card>
        <div className="px-3 pt-2">
          <Tabs active={status} onChange={setStatus}
            tabs={STATUS_TABS.map((t) => ({ key: t.key, label: t.label, count: t.key ? counts[t.key] ?? 0 : rows.length }))} />
        </div>
        <div className="flex flex-wrap items-end gap-3 border-b border-surface-border px-3 pb-3">
          <SearchInput className="w-72" value={flt.q} onChange={(v) => setFlt((f) => ({ ...f, q: v }))} placeholder="EWB / doc no / consignee / vehicle" />
          <Select className="w-56" value={flt.source_type} onChange={(e) => setFlt((f) => ({ ...f, source_type: e.target.value }))}
            options={[{ value: '', label: 'All documents' }, ...(meta.data?.source_types ?? []), { value: 'MANUAL', label: 'Manual' }]} />
          <Input className="w-40" type="date" label="Document from" value={flt.from} onChange={(e) => setFlt((f) => ({ ...f, from: e.target.value }))} />
          <Input className="w-40" type="date" label="To" value={flt.to} onChange={(e) => setFlt((f) => ({ ...f, to: e.target.value }))} />
        </div>
        {list.isLoading ? <LoadingBlock /> : !shown.length ? (
          <EmptyState title="No e-way bills" message={rows.length ? 'Nothing in this status.' : 'Make one from a dispatch, process DC, purchase return, gate outward or stock delivery.'}
            action={can('EWAY.CREATE') && !rows.length ? <Button onClick={() => setPicking(true)}><Plus size={15} />New e-way bill</Button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" id="ewb-list">
              <thead><tr>
                <th className="th">Doc no</th><th className="th">EWB no</th><th className="th">Source</th><th className="th">Document</th>
                <th className="th">Consignee</th><th className="th">Vehicle</th><th className="th text-right">Value ₹</th><th className="th">Valid upto</th><th className="th">Status</th>
              </tr></thead>
              <tbody>{shown.map((r) => (
                <tr key={r.id} data-ewb-id={r.id} data-doc-no={r.doc_no} className="cursor-pointer hover:bg-brand-50/40" onClick={() => nav(`/logistics/eway-bills/${r.id}`)}>
                  <td className="td font-mono font-medium text-brand-700">{r.doc_no}</td>
                  <td className="td font-mono">{r.ewb_no ?? <span className="text-slate-400">—</span>}</td>
                  <td className="td"><div className="text-[11px] text-slate-500">{r.source_label}</div><div className="font-mono">{r.source_no ?? '—'}</div></td>
                  <td className="td"><div>{r.document_type} {r.document_number}</div><div className="text-[11px] text-slate-500">{fmtDate(r.document_date)}</div></td>
                  <td className="td"><div className="font-medium">{r.to_name}</div><div className="text-[11px] text-slate-500">{r.to_gstin}{r.to_place ? ` · ${r.to_place}` : ''}</div></td>
                  <td className="td font-mono">{r.vehicle_no ?? '—'}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.total_invoice_value)}</td>
                  <td className={clsx('td whitespace-nowrap', r.view_status === 'EXPIRED' ? 'font-semibold text-red-600' : r.expiring_soon ? 'font-semibold text-amber-600' : '')}>
                    {r.valid_upto ? fmtDateTime(r.valid_upto) : '—'}
                  </td>
                  <td className="td"><EwbStatus value={r.view_status} />{r.last_error && <div className="mt-0.5 max-w-[180px] truncate text-[11px] text-red-600" title={r.last_error}>{r.last_error}</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {picking && <SourcePickerModal open onClose={() => setPicking(false)} meta={meta.data} />}
    </div>
  );
}

/* ============================================================
   EDITOR / VIEW
============================================================ */

/** Header fields kept as text in the form; numbers / nulls are restored in `toPayload`. */
const TEXT_FIELDS = ['supply_type', 'sub_supply_type', 'sub_supply_desc', 'document_type', 'document_number', 'document_date', 'transaction_type',
  'from_gstin', 'from_name', 'from_address1', 'from_address2', 'from_place', 'from_pincode', 'from_state', 'dispatch_state',
  'to_party_id', 'to_gstin', 'to_name', 'to_address1', 'to_address2', 'to_place', 'to_pincode', 'to_state', 'ship_state', 'other_value',
  'transporter_party_id', 'transporter_id', 'transporter_name', 'transport_mode', 'distance_km', 'vehicle_no', 'vehicle_type',
  'transport_doc_no', 'transport_doc_date', 'remarks', 'source_type', 'source_id', 'source_no'] as const;
type Head = Record<(typeof TEXT_FIELDS)[number], string>;

const headFromServer = (h: any): Head => Object.fromEntries(TEXT_FIELDS.map((k) => [k, h?.[k] == null ? '' : String(h[k])])) as Head;
const nul = (v: string) => (v.trim() === '' ? null : v.trim());
function toPayload(f: Head, items: EwbItem[]) {
  return {
    ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, nul(f[k])])),
    source_type: f.source_type || 'MANUAL', source_id: f.source_id ? Number(f.source_id) : null,
    supply_type: f.supply_type || 'OUTWARD', document_number: f.document_number.trim(), document_date: f.document_date,
    transaction_type: Number(f.transaction_type) || 1, from_gstin: f.from_gstin.trim().toUpperCase(), from_name: f.from_name.trim(),
    to_party_id: f.to_party_id ? Number(f.to_party_id) : null, to_gstin: f.to_gstin.trim().toUpperCase() || 'URP', to_name: f.to_name.trim(),
    other_value: n(f.other_value), transporter_party_id: f.transporter_party_id ? Number(f.transporter_party_id) : null,
    transporter_id: nul(f.transporter_id.toUpperCase()), transport_mode: f.transport_mode || 'Road', distance_km: Math.round(n(f.distance_km)),
    vehicle_no: nul(f.vehicle_no.toUpperCase()), vehicle_type: f.vehicle_type || 'Regular',
    sub_supply_desc: f.sub_supply_type === 'Others' ? nul(f.sub_supply_desc) : null,
    items: items.map(itemToPayload),
  };
}

export function EwayBillEditorPage() {
  const { id: idParam } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const meta = useEwbMeta();
  const id = idParam ? Number(idParam) : null;
  const srcType = sp.get('source_type') ?? '';
  const srcId = Number(sp.get('source_id')) || 0;
  const isNew = !id;

  const pre = useQuery({
    queryKey: ['ewb-prefill', srcType, srcId],
    queryFn: async () => (await http.get<{ data: any }>('/eway-bills/prefill', { type: srcType, id: srcId })).data,
    enabled: isNew && !!srcType && srcId > 0, staleTime: 0, gcTime: 0, retry: false,
  });
  const rec = useQuery({
    queryKey: ['eway-bill', id],
    queryFn: async () => (await http.get<{ data: any }>(`/eway-bills/${id}`)).data,
    enabled: !!id, retry: false,
  });
  const transporters = useLookup('transporters');

  const e = rec.data;
  const [f, setF] = useState<Head | null>(null);
  const [items, setItems] = useState<EwbItem[]>([]);
  const [snap, setSnap] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<{ message: string; problems: string[] } | null>(null);
  const [modal, setModal] = useState<'' | 'generate' | 'partb' | 'extend' | 'cancel' | 'delete'>('');

  // (re)load the form whenever the server copy changes (prefill, load, save, portal action)
  const source = isNew ? pre.data?.header : e;
  const sourceItems = isNew ? pre.data?.items : e?.items;
  useEffect(() => {
    if (!source) return;
    const h = headFromServer(source); const it = (sourceItems ?? []).map(itemFromServer);
    setF(h); setItems(it); setSnap(JSON.stringify(toPayload(h, it)));
  }, [source, sourceItems]);

  const ro = !isNew && (e?.status !== 'DRAFT' || !can('EWAY.CREATE'));
  const set = (p: Partial<Head>) => setF((x) => (x ? { ...x, ...p } : x));
  const setItem = (key: string, p: Partial<EwbItem>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const payload = useMemo(() => (f ? toPayload(f, items) : null), [f, items]);
  const dirty = !!payload && JSON.stringify(payload) !== snap;
  const inter = f ? isInterState(f.from_state, f.to_state) : true;
  const tot = useMemo(() => computeTotals(items, inter, n(f?.other_value)), [items, inter, f?.other_value]);
  const totals = ro && e ? { taxable: n(e.taxable_amount), cgst: n(e.cgst_amount), sgst: n(e.sgst_amount), igst: n(e.igst_amount), cess: n(e.cess_amount), total: n(e.total_invoice_value) } : tot;
  const threshold = meta.data?.threshold ?? pre.data?.threshold ?? 50000;

  const save = async (quiet = false): Promise<boolean> => {
    if (!payload) return false;
    setBusy('save'); setErr(null);
    try {
      if (isNew) {
        const r = await http.post<{ data: any }>('/eway-bills', payload);
        qc.setQueryData(['eway-bill', r.data.id], r.data);
        qc.invalidateQueries({ queryKey: ['eway-bills'] });
        toast(`Draft ${r.data.doc_no} saved`);
        nav(`/logistics/eway-bills/${r.data.id}`, { replace: true });
      } else {
        const r = await http.put<{ data: any }>(`/eway-bills/${id}`, payload);
        qc.setQueryData(['eway-bill', id], r.data);
        qc.invalidateQueries({ queryKey: ['eway-bills'] });
        if (!quiet) toast('Draft saved');
      }
      return true;
    } catch (x) { setErr(parseError(x)); return false; } finally { setBusy(''); }
  };
  /** Portal action (generate / part-b / extend / cancel / refresh): the server returns the full record. */
  const run = async (path: string, body: Record<string, unknown>) => {
    const r = await http.post<{ data: any }>(`/eway-bills/${id}/${path}`, body);
    qc.setQueryData(['eway-bill', id], r.data);
    qc.invalidateQueries({ queryKey: ['eway-bills'] }); qc.invalidateQueries({ queryKey: ['eway-bills-alerts'] });
    toast({ generate: `E-way bill ${r.data.ewb_no} recorded`, 'part-b': 'Vehicle updated', extend: 'Validity extended', cancel: 'E-way bill cancelled', refresh: 'Refreshed from the portal' }[path] ?? 'Done');
    setErr(null);
    return true;
  };
  const startGenerate = async () => {
    if (dirty && !(await save(true))) return;
    setModal('generate');
  };
  const refresh = async () => {
    setBusy('refresh');
    try { await run('refresh', {}); } catch (x) { setErr(parseError(x)); qc.invalidateQueries({ queryKey: ['eway-bill', id] }); } finally { setBusy(''); }
  };
  const del = async () => {
    setBusy('delete');
    try { await http.del(`/eway-bills/${id}`); qc.invalidateQueries({ queryKey: ['eway-bills'] }); toast('Draft deleted'); nav('/logistics/eway-bills'); }
    catch (x) { toast(errMsg(x), 'error'); } finally { setBusy(''); setModal(''); }
  };
  const pickTransporter = (v: string) => {
    const t = transporters.data?.find((x) => String(x.id) === v);
    set({ transporter_party_id: v, transporter_id: t?.gstin ? String(t.gstin) : f?.transporter_id ?? '', transporter_name: t ? String(t.party_name ?? t.label) : f?.transporter_name ?? '' });
  };

  /* ---------- states before the form ---------- */
  const back = <Link to="/logistics/eway-bills" className="text-[12.5px] font-medium text-brand-700 hover:underline">← E-way bills</Link>;
  if (isNew && !(srcType && srcId)) {
    return (
      <div>
        <PageHeader title="New e-way bill" breadcrumb={['Logistics', 'E-way bills']} actions={back} />
        <Card><EmptyState title="Pick the document" message="An e-way bill is made from the document that moves the goods." /></Card>
        <SourcePickerModal open onClose={() => nav('/logistics/eway-bills')} meta={meta.data} />
      </div>
    );
  }
  const loading = meta.isLoading || (isNew ? pre.isLoading : rec.isLoading);
  const loadErr = isNew ? pre.error : rec.error;
  if (loadErr) {
    return <div><PageHeader title={isNew ? 'New e-way bill' : 'E-way bill'} breadcrumb={['Logistics', 'E-way bills']} actions={back} />
      <ErrorBox err={parseError(loadErr)} id="ewb-load-error" /></div>;
  }
  if (isNew && pre.data?.existing) {
    const x = pre.data.existing;
    return (
      <div>
        <PageHeader title="New e-way bill" breadcrumb={['Logistics', 'E-way bills']} actions={back} />
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800" id="ewb-existing">
          This document already has e-way bill <b className="font-mono">{x.ewb_no ?? x.doc_no}</b> ({x.status.toLowerCase()}). Cancel it before making another.
          <div className="mt-2"><Link to={`/logistics/eway-bills/${x.id}`} className="font-semibold text-brand-700 underline" id="ewb-existing-link">Open {x.doc_no}</Link></div>
        </div>
      </div>
    );
  }
  if (loading || !f || !meta.data) return <div><PageHeader title={isNew ? 'New e-way bill' : 'E-way bill'} breadcrumb={['Logistics', 'E-way bills']} /><Card><LoadingBlock /></Card></div>;

  const m = meta.data;
  const status: string = isNew ? 'DRAFT' : e.view_status;
  const notes: string[] = isNew ? pre.data?.notes ?? [] : [];
  const stateOpts = m.states.map((s) => ({ value: s, label: s }));
  const sourceLabel = isNew ? m.source_types.find((t) => t.value === f.source_type)?.label ?? f.source_type : e.source_label;
  const draft = isNew || e.status === 'DRAFT';

  return (
    <div>
      <PageHeader breadcrumb={['Logistics', 'E-way bills']}
        title={isNew ? 'New e-way bill' : e.ewb_no ? `E-way bill ${e.ewb_no}` : `E-way bill draft ${e.doc_no}`}
        subtitle={<>From {sourceLabel} <span className="font-mono">{f.source_no || '—'}</span>{!isNew && <> · {e.doc_no} · created {fmtDateTime(e.created_at)}{e.created_by_name ? ` by ${e.created_by_name}` : ''}</>}</>}
        actions={<div className="flex flex-wrap items-center gap-2">
          {back}
          {draft && can('EWAY.CREATE') && <Button id="ewb-save" variant={isNew ? 'primary' : 'secondary'} loading={busy === 'save'} disabled={!isNew && !dirty} onClick={() => save()}><Save size={15} />Save draft</Button>}
          {!isNew && draft && can('EWAY.CREATE') && <Button id="ewb-delete" variant="danger" onClick={() => setModal('delete')}><Trash2 size={15} />Delete</Button>}
          {!isNew && draft && can('EWAY.UPDATE') && <Button id="ewb-generate" disabled={!!busy} onClick={startGenerate}><Send size={15} />{m.online ? 'Generate' : 'Record EWB no'}</Button>}
          {!isNew && e.can_part_b && can('EWAY.UPDATE') && <Button id="ewb-partb" variant="secondary" onClick={() => setModal('partb')}><Truck size={15} />Update vehicle (Part B)</Button>}
          {!isNew && e.can_extend && can('EWAY.UPDATE') && <Button id="ewb-extend" variant="secondary" onClick={() => setModal('extend')}><CalendarClock size={15} />Extend validity</Button>}
          {!isNew && e.can_cancel && can('EWAY.APPROVE') && <Button id="ewb-cancel" variant="danger" onClick={() => setModal('cancel')}><Ban size={15} />Cancel</Button>}
          {!isNew && m.online && e.ewb_no && <Button id="ewb-refresh" variant="secondary" loading={busy === 'refresh'} onClick={refresh}><RefreshCw size={15} />Refresh</Button>}
          {!isNew && <Button id="ewb-print" variant="secondary" onClick={() => { if (!printEwayBill(e)) toast('Allow pop-ups to print', 'warning'); }}><Printer size={15} />Print</Button>}
        </div>} />
      <ModeNote meta={m} />

      {/* number / validity / status */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">E-way bill no</div>
            <div id="ewb-number" className={clsx('font-mono text-[26px] font-extrabold tracking-wider', e?.ewb_no ? 'text-slate-900' : 'text-slate-300')}>{e?.ewb_no ?? 'Not generated'}</div>
          </div>
          <div><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</div><EwbStatus id="ewb-status" value={status} size="lg" /></div>
          {e?.ewb_date && <div><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Generated</div><div className="text-[13px] font-medium">{fmtDateTime(e.ewb_date)}</div></div>}
          {e?.status === 'GENERATED' && <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Valid upto</div>
            <div id="ewb-valid-upto" className={clsx('text-[13px] font-semibold', status === 'EXPIRED' ? 'text-red-600' : e.can_extend ? 'text-amber-600' : 'text-slate-900')}>
              {e.valid_upto ? fmtDateTime(e.valid_upto) : 'Part B not entered — add the vehicle to start the validity'}</div>
          </div>}
          {e?.status === 'CANCELLED' && <div className="text-[12.5px] text-red-700"><b>Cancelled</b> {fmtDateTime(e.cancelled_at)}{e.cancelled_by_name ? ` by ${e.cancelled_by_name}` : ''} — {e.cancel_reason}: {e.cancel_remark}</div>}
          <div className="ml-auto text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Total invoice value</div>
            <div className="text-[20px] font-bold tabular-nums" id="ewb-total" data-value={totals.total}>₹{fmtDecimal(totals.total)}</div>
          </div>
        </div>
      </Card>

      {e?.last_error && <ErrorBox err={{ message: `Last portal error: ${e.last_error}`, problems: [] }} id="ewb-last-error" />}
      <ErrorBox err={err} id="ewb-error" />
      {!!notes.length && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] text-amber-800" id="ewb-notes">
          <div className="mb-0.5 flex items-center gap-1.5 font-semibold"><Info size={14} />Check before saving</div>
          <ul className="list-disc space-y-0.5 pl-5">{notes.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      {draft && totals.total < threshold && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-[12.5px] text-slate-600" id="ewb-threshold">
          <Info size={14} />Not required below ₹{fmtDecimal(threshold, 0)} (you can still generate).
        </div>
      )}

      <Card className="mb-4">
        <fieldset disabled={ro} className="p-5">
          <FormSection title="Document" cols={4}>
            <Select label="Supply" value={f.supply_type} onChange={(x) => set({ supply_type: x.target.value })} options={[{ value: 'OUTWARD', label: 'Outward' }, { value: 'INWARD', label: 'Inward' }]} />
            <Select label="Sub supply type" id="ewb-sub-supply" value={f.sub_supply_type} onChange={(x) => set({ sub_supply_type: x.target.value })} options={m.sub_supply_types.map((s) => ({ value: s, label: s }))} />
            {f.sub_supply_type === 'Others'
              ? <Input label="Sub supply description" required maxLength={100} value={f.sub_supply_desc} onChange={(x) => set({ sub_supply_desc: x.target.value })} />
              : <div className="hidden lg:block" />}
            <Select label="Transaction type" value={f.transaction_type} onChange={(x) => set({ transaction_type: x.target.value })} options={TRANSACTION_TYPES} />
            <Select label="Document type" value={f.document_type} onChange={(x) => set({ document_type: x.target.value })} options={m.document_types.map((s) => ({ value: s, label: s }))} />
            <Input label="Document no" required id="ewb-doc-no" maxLength={16} value={f.document_number} hint="Up to 16 letters / digits / ‘/’ / ‘-’"
              onChange={(x) => set({ document_number: x.target.value })} />
            <Input label="Document date" required type="date" value={f.document_date} onChange={(x) => set({ document_date: x.target.value })} />
          </FormSection>

          <FormSection title="From — consignor" cols={4}>
            <Input label="GSTIN" required maxLength={15} value={f.from_gstin} onChange={(x) => set({ from_gstin: x.target.value.toUpperCase() })} />
            <Input label="Name" required className="sm:col-span-2 lg:col-span-3" maxLength={100} value={f.from_name} onChange={(x) => set({ from_name: x.target.value })} />
            <Input label="Address line 1" className="sm:col-span-2" maxLength={120} value={f.from_address1} onChange={(x) => set({ from_address1: x.target.value })} />
            <Input label="Address line 2" className="sm:col-span-2" maxLength={120} value={f.from_address2} onChange={(x) => set({ from_address2: x.target.value })} />
            <Input label="Place" maxLength={50} value={f.from_place} onChange={(x) => set({ from_place: x.target.value })} />
            <Input label="PIN code" required maxLength={6} value={f.from_pincode} onChange={(x) => set({ from_pincode: x.target.value.replace(/\D/g, '') })} />
            <Select label="State" required value={f.from_state} onChange={(x) => set({ from_state: x.target.value })} placeholder="Select…" options={stateOpts} />
            <Select label="Dispatch from state" value={f.dispatch_state} onChange={(x) => set({ dispatch_state: x.target.value })} placeholder="Same as state" options={stateOpts} />
          </FormSection>

          <FormSection title="To — consignee" cols={4}>
            <Input label="GSTIN" required id="ewb-to-gstin" maxLength={15} value={f.to_gstin} hint="URP = unregistered person"
              onChange={(x) => set({ to_gstin: x.target.value.toUpperCase() })} />
            <Input label="Name" required className="sm:col-span-2 lg:col-span-3" maxLength={100} value={f.to_name} onChange={(x) => set({ to_name: x.target.value })} />
            <Input label="Address line 1" className="sm:col-span-2" maxLength={120} value={f.to_address1} onChange={(x) => set({ to_address1: x.target.value })} />
            <Input label="Address line 2" className="sm:col-span-2" maxLength={120} value={f.to_address2} onChange={(x) => set({ to_address2: x.target.value })} />
            <Input label="Place" id="ewb-to-place" maxLength={50} value={f.to_place} onChange={(x) => set({ to_place: x.target.value })} />
            <Input label="PIN code" required id="ewb-to-pincode" maxLength={6} value={f.to_pincode} onChange={(x) => set({ to_pincode: x.target.value.replace(/\D/g, '') })} />
            <Select label="State of supply" required id="ewb-to-state" value={f.to_state} onChange={(x) => set({ to_state: x.target.value })} placeholder="Select…" options={stateOpts} />
            <Select label="Ship to state" value={f.ship_state} onChange={(x) => set({ ship_state: x.target.value })} placeholder="Same as state of supply" options={stateOpts} />
          </FormSection>

          <FormSection title="Items" cols={1} description={`${inter ? 'Inter-state — IGST' : 'Intra-state — CGST + SGST'}; enter one GST rate per line, the server splits it.`}
            actions={!ro && <Button size="sm" variant="secondary" id="ewb-add-item" onClick={() => setItems((xs) => [...xs, emptyItem()])}><FilePlus2 size={13} />Add line</Button>}>
            <div className="overflow-x-auto rounded-lg border border-surface-border">
              <table className="w-full text-[12.5px]" id="ewb-items">
                <thead><tr>
                  <th className="th w-8">#</th><th className="th min-w-[180px]">Product</th><th className="th min-w-[140px]">Description</th><th className="th w-28">HSN</th>
                  <th className="th w-24 text-right">Qty</th><th className="th w-20">Unit</th><th className="th w-32 text-right">Taxable ₹</th>
                  <th className="th w-20 text-right">GST %</th><th className="th w-28 text-right">Tax ₹</th>{!ro && <th className="th w-10" />}
                </tr></thead>
                <tbody>{items.map((it, i) => (
                  <tr key={it.key} data-item-row={i}>
                    <td className="td text-slate-500">{i + 1}</td>
                    <td className="td !py-1.5"><input className="input !h-8" data-f="product_name" maxLength={100} value={it.product_name} onChange={(x) => setItem(it.key, { product_name: x.target.value })} /></td>
                    <td className="td !py-1.5"><input className="input !h-8" data-f="description" maxLength={100} value={it.description} onChange={(x) => setItem(it.key, { description: x.target.value })} /></td>
                    <td className="td !py-1.5"><input className={clsx('input !h-8 font-mono', !/^\d{4,8}$/.test(it.hsn_code) && 'input-error')} data-f="hsn_code" inputMode="numeric" maxLength={8} value={it.hsn_code}
                      onChange={(x) => setItem(it.key, { hsn_code: x.target.value.replace(/\D/g, '') })} /></td>
                    <td className="td !py-1.5"><input className="input !h-8 text-right" data-f="quantity" inputMode="decimal" value={it.quantity} onChange={(x) => setItem(it.key, { quantity: x.target.value.replace(/[^0-9.]/g, '') })} /></td>
                    <td className="td !py-1.5"><input className="input !h-8" data-f="unit" maxLength={8} value={it.unit} onChange={(x) => setItem(it.key, { unit: x.target.value.toUpperCase() })} /></td>
                    <td className="td !py-1.5"><input className="input !h-8 text-right" data-f="taxable_amount" inputMode="decimal" value={it.taxable_amount} onChange={(x) => setItem(it.key, { taxable_amount: x.target.value.replace(/[^0-9.]/g, '') })} /></td>
                    <td className="td !py-1.5"><select className="input !h-8 text-right" data-f="rate" value={it.rate} onChange={(x) => setItem(it.key, { rate: x.target.value })}>
                      {[...new Set(['0', '0.25', '3', '5', '12', '18', '28', it.rate])].map((r) => <option key={r} value={r}>{r}</option>)}</select></td>
                    <td className="td text-right tabular-nums text-slate-600">{fmtDecimal((n(it.taxable_amount) * n(it.rate)) / 100)}</td>
                    {!ro && <td className="td !py-1.5"><button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30" data-remove-item={i}
                      title="Remove line" disabled={items.length <= 1} onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}><Trash2 size={14} /></button></td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end justify-end gap-x-6 gap-y-2 text-[12.5px]" id="ewb-totals">
              <Input label="Other charges ₹" className="w-36" inputMode="decimal" value={f.other_value} onChange={(x) => set({ other_value: x.target.value.replace(/[^0-9.-]/g, '') })} />
              {[['Taxable', totals.taxable], ['CGST', totals.cgst], ['SGST', totals.sgst], ['IGST', totals.igst], ...(totals.cess ? [['Cess', totals.cess]] : [])].map(([k, v]) => (
                <div key={k as string} className="text-right"><div className="text-[11px] uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold tabular-nums" data-total={k}>{fmtDecimal(v)}</div></div>
              ))}
              <div className="text-right"><div className="text-[11px] uppercase tracking-wider text-slate-500">Total ₹</div><div className="text-[15px] font-bold tabular-nums">{fmtDecimal(totals.total)}</div></div>
            </div>
          </FormSection>

          <FormSection title="Transport — Part B" cols={4} description="Distance 0 = the portal works it out from the PIN codes. Without a vehicle the e-way bill is Part-A only until the vehicle is added.">
            <Select label="Transporter" value={f.transporter_party_id} onChange={(x) => pickTransporter(x.target.value)} placeholder="— none —"
              options={(transporters.data ?? []).map((t) => ({ value: String(t.id), label: t.label }))} />
            <Input label="Transporter ID (GSTIN / TRANSIN)" maxLength={15} value={f.transporter_id} onChange={(x) => set({ transporter_id: x.target.value.toUpperCase() })} />
            <Input label="Transporter name" maxLength={100} value={f.transporter_name} onChange={(x) => set({ transporter_name: x.target.value })} />
            <Select label="Mode" value={f.transport_mode} onChange={(x) => set({ transport_mode: x.target.value })} options={TRANSPORT_MODES.map((t) => ({ value: t, label: t }))} />
            <Input label="Distance (km)" type="number" min={0} max={4000} id="ewb-distance" value={f.distance_km} onChange={(x) => set({ distance_km: x.target.value })} />
            <Input label="Vehicle no" id="ewb-vehicle" maxLength={20} placeholder="TN39AB1234" value={f.vehicle_no} onChange={(x) => set({ vehicle_no: x.target.value.toUpperCase() })} />
            <Select label="Vehicle type" value={f.vehicle_type} onChange={(x) => set({ vehicle_type: x.target.value })} options={VEHICLE_TYPES} />
            <div className="hidden lg:block" />
            <Input label="LR / transport doc no" maxLength={15} value={f.transport_doc_no} onChange={(x) => set({ transport_doc_no: x.target.value })} />
            <Input label="LR / transport doc date" type="date" value={f.transport_doc_date} onChange={(x) => set({ transport_doc_date: x.target.value })} />
            <Textarea label="Remarks" className="sm:col-span-2" rows={2} maxLength={300} value={f.remarks} onChange={(x) => set({ remarks: x.target.value })} />
          </FormSection>
        </fieldset>
      </Card>

      {!isNew && (
        <Card title="History" subtitle="Every portal action with what came back">
          {!e.events?.length ? <EmptyState title="Nothing yet" message="Generate, vehicle updates, extensions and cancellation are logged here." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" id="ewb-events">
                <thead><tr><th className="th">Action</th><th className="th">Result</th><th className="th">Message</th><th className="th">User</th><th className="th">Time</th></tr></thead>
                <tbody>{e.events.map((ev: any) => (
                  <tr key={ev.id} data-event={ev.action}>
                    <td className="td font-medium">{ev.action.replace(/_/g, ' ')}<div className="text-[11px] text-slate-500">{ev.provider}</div></td>
                    <td className="td">{n(ev.ok) ? <span className="font-semibold text-emerald-600">OK</span> : <span className="font-semibold text-red-600">Failed</span>}</td>
                    <td className="td max-w-[520px] break-words">{ev.message ?? '—'}</td>
                    <td className="td">{ev.user_name ?? '—'}</td>
                    <td className="td whitespace-nowrap">{fmtDateTime(ev.created_at)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {modal === 'generate' && <GenerateModal open onClose={() => setModal('')} meta={m} run={run} total={fmtDecimal(totals.total)} />}
      {modal === 'partb' && <PartBModal open onClose={() => setModal('')} meta={m} run={run} e={e} />}
      {modal === 'extend' && <ExtendModal open onClose={() => setModal('')} meta={m} run={run} e={e} />}
      {modal === 'cancel' && <CancelModal open onClose={() => setModal('')} meta={m} run={run} e={e} />}
      <ConfirmDialog open={modal === 'delete'} title="Delete draft" message={`Delete draft e-way bill ${e?.doc_no ?? ''}? This cannot be undone.`}
        busy={busy === 'delete'} onConfirm={del} onCancel={() => setModal('')} />
    </div>
  );
}
