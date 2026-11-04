import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  PageHeader, Card, Button, Input, Select, Textarea, Checkbox, Tabs, Badge, Modal, LoadingBlock, ErrorState, EmptyState, SearchInput, useDebounced, FormSection,
} from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, today } from '../../lib/format';
import {
  LabStatus, ResultBadge, ReasonModal, AttachmentList, FilePick, KV, errMsg, label, opts, num, uploadLabFile, useLabJobs,
  TEST_SCOPES, SOURCES, SAMPLE_TYPES, SAMPLE_UOMS,
} from './labShared';

/** Lab requests (spec §4.1): register, create / edit form, request detail with its samples, trials, reports and timeline. */

const REQ_STATUSES = ['DRAFT', 'SUBMITTED', 'CLARIFICATION_REQUIRED', 'SAMPLE_RECEIVED', 'IN_TESTING', 'PENDING_LAB_REVIEW', 'PENDING_QA_APPROVAL', 'APPROVED', 'REJECTED', 'RETEST_REQUIRED', 'CANCELLED', 'CLOSED'];

/* ================================================================ register */
export function LabRequestsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const buyers = useLookup('buyers');
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q);
  const f = { status: sp.get('status') ?? '', buyer_id: sp.get('buyer_id') ?? '', priority: sp.get('priority') ?? '', scope: sp.get('scope') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '', open: sp.get('open') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['lab-requests', f, dq, page],
    queryFn: async () => http.get<{ data: any[]; meta: { total: number; page: number; pageSize: number } }>('/lab/requests',
      { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: dq || undefined, page, pageSize: 50 }),
  });
  const cols: Column<any>[] = [
    { key: 'request_no', header: 'Request no', render: (r) => <Link className="font-semibold text-brand-700 hover:underline" to={`/lab/requests/${r.id}`}>{r.request_no}</Link> },
    { key: 'request_date', header: 'Requested / due', render: (r) => <div className="text-small"><p>{fmtDate(r.request_date)}</p>
      <p className={r.days_to_due < 0 && !['APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'].includes(r.status) ? 'font-semibold text-red-600' : 'text-ink-secondary'}>→ {fmtDate(r.required_date)}</p></div> },
    { key: 'buyer_name', header: 'Buyer / order / style', render: (r) => <div className="text-small"><p className="font-medium">{r.buyer_name ?? '—'}</p>
      <p className="text-ink-secondary">{r.is_development ? `Development ${r.development_ref ?? ''}` : r.job_no ?? '—'} · {r.style_code ?? '—'}{r.color_name ? ` · ${r.color_name}` : ''}</p></div> },
    { key: 'test_scope', header: 'Scope', render: (r) => <span className="text-small">{(r.test_scope ?? []).map(label).join(', ')}</span> },
    { key: 'priority', header: 'Priority', render: (r) => r.priority === 'URGENT' ? <Badge tone="red">Urgent</Badge> : <span className="text-ink-secondary">Normal</span> },
    { key: 'counts', header: 'Samples / trials / reports', align: 'right', render: (r) => <span className="tabular-nums">{r.sample_count} / {r.trial_count} / {r.report_count}</span> },
    { key: 'status', header: 'Status', render: (r) => <LabStatus value={r.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Lab requests" breadcrumb={['Lab']} subtitle="Test requests against buyer, order, style, colour and fabric"
        actions={can('LAB.CREATE') && <Button id="lab-req-new" onClick={() => nav('/lab/requests/create')}><Plus size={15} />New request</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <SearchInput className="w-64" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Request, style, buyer, order, lot…" />
        <Select label="Status" className="w-48" placeholder="All" options={opts(REQ_STATUSES)} value={f.status} onChange={(e) => setF('status', e.target.value)} />
        <Select label="Buyer" className="w-48" placeholder="All buyers" options={toOptions(buyers.data)} value={f.buyer_id} onChange={(e) => setF('buyer_id', e.target.value)} />
        <Select label="Scope" className="w-44" placeholder="Any" options={opts(TEST_SCOPES)} value={f.scope} onChange={(e) => setF('scope', e.target.value)} />
        <Select label="Priority" className="w-32" placeholder="Any" options={opts(['NORMAL', 'URGENT'])} value={f.priority} onChange={(e) => setF('priority', e.target.value)} />
        <Input label="From" type="date" className="w-40" value={f.from} onChange={(e) => setF('from', e.target.value)} />
        <Input label="To" type="date" className="w-40" value={f.to} onChange={(e) => setF('to', e.target.value)} />
        <div className="pb-2"><Checkbox label="Open only" checked={f.open === '1'} onChange={(v) => setF('open', v ? '1' : '')} /></div>
      </div>
      <div className="card" id="lab-req-list">
        <DataTable columns={cols} rows={list.data?.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} rowKey={(r: any) => r.id}
          emptyTitle="No lab requests" onRowClick={(r: any) => nav(`/lab/requests/${r.id}`)}
          pagination={list.data?.meta ? { ...list.data.meta, totalPages: Math.ceil(list.data.meta.total / list.data.meta.pageSize) } : undefined} onPage={setPage} />
      </div>
    </div>
  );
}

/* ================================================================ form */
interface Item { item_description: string; size_id: string; sample_type: string; requested_qty: string; uom: string; due_date: string; remarks: string }
const emptyItem = (): Item => ({ item_description: '', size_id: '', sample_type: 'GARMENT', requested_qty: '', uom: 'PCS', due_date: '', remarks: '' });

export function LabRequestFormPage() {
  const { id } = useParams();
  const editId = id ? Number(id) : null;
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const jobs = useLabJobs();
  const buyers = useLookup('buyers'); const styles = useLookup('styles'); const colors = useLookup('colors');
  const sizes = useLookup('sizes-all'); const fabrics = useLookup('fabrics');
  const existing = useQuery({ queryKey: ['lab-request', editId], enabled: !!editId, queryFn: async () => (await http.get<{ data: any }>(`/lab/requests/${editId}`)).data });
  const [h, setH] = useState<Record<string, any>>({
    required_date: '', source: 'MERCHANDISING', priority: 'NORMAL', so_id: '', buyer_id: '', buyer_po_no: '', style_id: '', color_id: '', size_id: '',
    item_description: '', fabric_id: '', composition: '', gsm: '', fabric_lot: '', test_plan_id: '', is_development: false, development_ref: '', development_reason: '',
    buyer_standard: '', remarks: '',
  });
  const [scope, setScope] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [tab, setTab] = useState('order');
  const [busy, setBusy] = useState<'' | 'save' | 'submit'>('');
  const [errs, setErrs] = useState<string[]>([]);
  const [protocol, setProtocol] = useState<File | null>(null);
  const [rowVersion, setRowVersion] = useState<number | null>(null);

  useEffect(() => {
    const r = existing.data; if (!r) return;
    const s = (v: unknown) => (v == null ? '' : String(v));
    setH({ required_date: s(r.required_date).slice(0, 10), source: r.source, priority: r.priority, so_id: s(r.so_id), buyer_id: s(r.buyer_id), buyer_po_no: s(r.buyer_po_no),
      style_id: s(r.style_id), color_id: s(r.color_id), size_id: s(r.size_id), item_description: s(r.item_description), fabric_id: s(r.fabric_id), composition: s(r.composition),
      gsm: s(r.gsm), fabric_lot: s(r.fabric_lot), test_plan_id: s(r.test_plan_id), is_development: !!Number(r.is_development), development_ref: s(r.development_ref),
      development_reason: s(r.development_reason), buyer_standard: s(r.buyer_standard), remarks: s(r.remarks) });
    setScope(r.test_scope ?? []);
    setItems((r.items ?? []).map((i: any) => ({ item_description: s(i.item_description), size_id: s(i.size_id), sample_type: i.sample_type, requested_qty: s(Number(i.requested_qty)),
      uom: i.uom, due_date: s(i.due_date).slice(0, 10), remarks: s(i.remarks) })));
    setRowVersion(Number(r.row_version));
  }, [existing.data]);

  const set = (k: string, v: unknown) => setH((x) => ({ ...x, [k]: v }));
  const job = (jobs.data ?? []).find((j) => String(j.id) === String(h.so_id));
  const styleOpts = job ? job.styles.map((x) => ({ value: x.style_id, label: `${x.style_code} — ${x.style_name}` }))
    : toOptions((styles.data ?? []).filter((x: any) => !h.buyer_id || !x.buyer_id || String(x.buyer_id) === String(h.buyer_id)));
  const plans = useQuery({
    queryKey: ['lab-applicable-plans', h.buyer_id, h.style_id, h.fabric_id, scope.join(',')],
    queryFn: async () => (await http.get<{ data: any[] }>('/lab/test-plans/applicable', { buyer_id: h.buyer_id || undefined, style_id: h.style_id || undefined, fabric_id: h.fabric_id || undefined, scope: scope.join(',') || undefined })).data,
  });
  const planOpts = useMemo(() => {
    const o = (plans.data ?? []).map((p) => ({ value: p.id, label: p.label }));
    if (h.test_plan_id && !o.some((x) => String(x.value) === String(h.test_plan_id))) o.unshift({ value: Number(h.test_plan_id), label: `Plan #${h.test_plan_id} (not applicable / inactive)` });
    return o;
  }, [plans.data, h.test_plan_id]);

  const pickJob = (v: string) => {
    const j = (jobs.data ?? []).find((x) => String(x.id) === v);
    setH((x) => ({ ...x, so_id: v, buyer_id: j?.buyer_id ? String(j.buyer_id) : x.buyer_id, buyer_po_no: j?.buyer_po_no ?? x.buyer_po_no,
      style_id: j && j.styles.length === 1 ? String(j.styles[0].style_id) : j ? '' : x.style_id }));
  };
  const pickFabric = (v: string) => {
    const f = (fabrics.data ?? []).find((x: any) => String(x.id) === v) as any;
    setH((x) => ({ ...x, fabric_id: v, gsm: f?.gsm_value ? String(f.gsm_value) : x.gsm }));
  };

  const body = (submit: boolean) => ({
    required_date: h.required_date, source: h.source, priority: h.priority, so_id: h.so_id || null, buyer_id: h.buyer_id || null, buyer_po_no: h.buyer_po_no || null,
    style_id: h.style_id || null, color_id: h.color_id || null, size_id: h.size_id || null, item_description: h.item_description || null, fabric_id: h.fabric_id || null,
    composition: h.composition || null, gsm: h.gsm || null, fabric_lot: h.fabric_lot || null, test_scope: scope, test_plan_id: h.test_plan_id || null,
    is_development: h.is_development, development_ref: h.development_ref || null, development_reason: h.development_reason || null, buyer_standard: h.buyer_standard || null,
    remarks: h.remarks || null, row_version: rowVersion, submit,
    items: items.filter((i) => i.requested_qty).map((i) => ({ ...i, size_id: i.size_id || null, due_date: i.due_date || null, item_description: i.item_description || null, remarks: i.remarks || null })),
  });
  const save = async (submit: boolean) => {
    const e: string[] = [];
    if (!h.required_date) e.push('Required date is required');
    if (!scope.length) e.push('Choose the test scope');
    if (!items.some((i) => Number(i.requested_qty) > 0)) e.push('Add the sample requirement (quantity)');
    if (submit && !h.test_plan_id) e.push('Choose the test plan');
    setErrs(e); if (e.length) return;
    setBusy(submit ? 'submit' : 'save');
    try {
      const res = editId ? await http.put<{ data: any }>(`/lab/requests/${editId}`, body(submit)) : await http.post<{ data: any }>('/lab/requests', body(submit));
      const rid = res.data.id;
      if (protocol) {
        try { await uploadLabFile(protocol, { request_id: rid, attachment_type: 'BUYER_PROTOCOL', caption: 'Buyer test protocol' }); }
        catch (x) { toast(`Saved, but the protocol upload failed: ${errMsg(x)}`, 'error'); }
      }
      void qc.invalidateQueries({ queryKey: ['lab-requests'] }); void qc.invalidateQueries({ queryKey: ['lab-request', rid] });
      toast(submit ? `Request ${res.data.request_no} submitted` : `Request ${res.data.request_no} saved`);
      nav(`/lab/requests/${rid}`);
    } catch (x) {
      const d = (x as any)?.details;
      setErrs(Array.isArray(d) && d.length ? d.map((y: any) => y.message ?? String(y)) : [errMsg(x)]);
    } finally { setBusy(''); }
  };

  if (editId && existing.isLoading) return <div className="card"><LoadingBlock /></div>;
  if (editId && existing.error) return <div className="card"><ErrorState error={existing.error} /></div>;
  if (existing.data && !['DRAFT', 'CLARIFICATION_REQUIRED'].includes(existing.data.status))
    return <div className="card"><EmptyState title="This request is submitted" message="Use Amend on the request to change the controlled fields." action={<Link className="btn-secondary" to={`/lab/requests/${editId}`}>Open request</Link>} /></div>;

  return (
    <div>
      <PageHeader title={editId ? `Edit ${existing.data?.request_no ?? ''}` : 'New lab request'} breadcrumb={['Lab', 'Requests']}
        subtitle={existing.data?.status === 'CLARIFICATION_REQUIRED' ? `Returned: ${existing.data.status_reason}` : 'Request date is today; requester is you'}
        actions={<>
          <Button variant="secondary" onClick={() => nav(editId ? `/lab/requests/${editId}` : '/lab/requests')}>Cancel</Button>
          <Button id="lab-req-save" variant="secondary" loading={busy === 'save'} onClick={() => void save(false)}>Save draft</Button>
          <Button id="lab-req-submit" loading={busy === 'submit'} onClick={() => void save(true)}>Save & submit</Button>
        </>} />
      {errs.length > 0 && <div id="lab-req-errors" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-small text-red-700">{errs.map((e) => <p key={e}>{e}</p>)}</div>}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'order', label: 'Buyer / order / style' }, { key: 'sample', label: 'Sample details', count: items.length }, { key: 'scope', label: 'Test scope & plan' }, { key: 'files', label: 'Attachments' }]} />
      <div className="card p-4">
        {tab === 'order' && (
          <>
            <FormSection title="Request">
              <Input label="Request date" value={fmtDate(existing.data?.request_date ?? today())} disabled />
              <Input id="lab-req-required" label="Required date" type="date" required value={h.required_date} min={today()} onChange={(e) => set('required_date', e.target.value)} />
              <Select label="Source" options={opts(SOURCES)} value={h.source} onChange={(e) => set('source', e.target.value)} />
              <Select label="Priority" options={opts(['NORMAL', 'URGENT'])} value={h.priority} onChange={(e) => set('priority', e.target.value)} />
            </FormSection>
            <FormSection title="Order context" description="Order work needs the order and style; a development / proto sample needs its reference and a reason">
              <div className="flex items-end pb-2 sm:col-span-2 lg:col-span-3 xl:col-span-4"><Checkbox label="Development / proto sample (no order)" checked={h.is_development} onChange={(v) => set('is_development', v)} /></div>
              {h.is_development ? (
                <>
                  <Input id="lab-req-devref" label="Development / proto reference" required value={h.development_ref} onChange={(e) => set('development_ref', e.target.value)} />
                  <Input label="Reason" required className="sm:col-span-2" value={h.development_reason} onChange={(e) => set('development_reason', e.target.value)} />
                </>
              ) : (
                <Select id="lab-req-job" label="Order (I/O)" required className="sm:col-span-2" placeholder={jobs.isLoading ? 'Loading…' : '— Select order —'}
                  options={(jobs.data ?? []).map((j) => ({ value: j.id, label: `${j.label}${j.buyer_po_no ? ` · PO ${j.buyer_po_no}` : ''}` }))} value={h.so_id} onChange={(e) => pickJob(e.target.value)} />
              )}
              <Select id="lab-req-buyer" label="Buyer" placeholder="—" options={toOptions(buyers.data)} value={h.buyer_id} onChange={(e) => set('buyer_id', e.target.value)} disabled={!!job?.buyer_id} />
              <Input label="Buyer PO" value={h.buyer_po_no} onChange={(e) => set('buyer_po_no', e.target.value)} />
              <Select id="lab-req-style" label="Style" required={!h.is_development} placeholder="—" options={styleOpts} value={h.style_id} onChange={(e) => set('style_id', e.target.value)} />
              <Select id="lab-req-color" label="Colour" placeholder="—" options={toOptions(colors.data)} value={h.color_id} onChange={(e) => set('color_id', e.target.value)} />
              <Select label="Size" placeholder="—" options={toOptions(sizes.data)} value={h.size_id} onChange={(e) => set('size_id', e.target.value)} />
              <Input label="Item / sample descriptor" className="sm:col-span-2" value={h.item_description} onChange={(e) => set('item_description', e.target.value)} />
            </FormSection>
            <FormSection title="Fabric">
              <Select id="lab-req-fabric" label="Fabric" placeholder="—" options={toOptions(fabrics.data)} value={h.fabric_id} onChange={(e) => pickFabric(e.target.value)} />
              <Input label="Composition" value={h.composition} onChange={(e) => set('composition', e.target.value)} hint="Blank = from the fabric master" />
              <Input label="GSM" type="number" value={h.gsm} onChange={(e) => set('gsm', e.target.value)} />
              <Input label="Lot / batch / dye lot" value={h.fabric_lot} onChange={(e) => set('fabric_lot', e.target.value)} />
            </FormSection>
          </>
        )}
        {tab === 'sample' && (
          <div className="overflow-x-auto" id="lab-req-items">
            <table className="w-full min-w-[900px]">
              <thead><tr><th className="th">Sample type</th><th className="th">Descriptor</th><th className="th">Size</th><th className="th text-right">Qty</th><th className="th">UOM</th><th className="th">Due</th><th className="th">Remarks</th><th className="th" /></tr></thead>
              <tbody>
                {items.map((it, i) => {
                  const up = (k: keyof Item, v: string) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
                  return (
                    <tr key={i}>
                      <td className="td"><select className="input" value={it.sample_type} onChange={(e) => up('sample_type', e.target.value)}>{SAMPLE_TYPES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></td>
                      <td className="td"><input className="input" value={it.item_description} onChange={(e) => up('item_description', e.target.value)} /></td>
                      <td className="td"><select className="input" value={it.size_id} onChange={(e) => up('size_id', e.target.value)}><option value="">—</option>{(sizes.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></td>
                      <td className="td"><input className="input w-24 text-right" type="number" min="0" step="any" name={`item-qty-${i}`} value={it.requested_qty} onChange={(e) => up('requested_qty', e.target.value)} /></td>
                      <td className="td"><select className="input w-28" value={it.uom} onChange={(e) => up('uom', e.target.value)}>{SAMPLE_UOMS.map((x) => <option key={x} value={x}>{x}</option>)}</select></td>
                      <td className="td"><input className="input" type="date" value={it.due_date} onChange={(e) => up('due_date', e.target.value)} /></td>
                      <td className="td"><input className="input" value={it.remarks} onChange={(e) => up('remarks', e.target.value)} /></td>
                      <td className="td"><button type="button" aria-label="Remove line" className="text-ink-muted hover:text-red-600" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}><Trash2 size={15} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button variant="secondary" className="mt-3" onClick={() => setItems((xs) => [...xs, emptyItem()])}><Plus size={14} />Add line</Button>
          </div>
        )}
        {tab === 'scope' && (
          <>
            <FormSection title="Test scope" cols={3}>
              {TEST_SCOPES.map((x) => <Checkbox key={x} label={label(x)} checked={scope.includes(x)} onChange={(v) => setScope((s) => (v ? [...s, x] : s.filter((y) => y !== x)))} />)}
            </FormSection>
            <FormSection title="Test plan" description="Active plans that fit the buyer / style / fabric / scope; the plan version is frozen when you submit" cols={2}>
              <Select id="lab-req-plan" label="Test plan" required placeholder={plans.isLoading ? 'Loading…' : planOpts.length ? '— Select plan —' : 'No applicable active plan'} options={planOpts}
                value={h.test_plan_id} onChange={(e) => set('test_plan_id', e.target.value)} />
              <Input label="Buyer standard / protocol reference" value={h.buyer_standard} onChange={(e) => set('buyer_standard', e.target.value)} />
              <Textarea label="Special instructions / remarks" className="sm:col-span-2" value={h.remarks} onChange={(e) => set('remarks', e.target.value)} />
            </FormSection>
          </>
        )}
        {tab === 'files' && (
          <div className="space-y-3">
            <p className="text-small text-ink-secondary">Attach the buyer test protocol / specification (PDF, image, Excel, Word). It uploads when the request is saved.</p>
            <div className="flex items-center gap-3">
              <FilePick id="lab-req-protocol" label={protocol ? 'Change file' : 'Choose protocol file'} onPick={setProtocol} />
              {protocol && <span className="text-small">{protocol.name} <button type="button" className="text-red-600 hover:underline" onClick={() => setProtocol(null)}>remove</button></span>}
            </div>
            {existing.data && <AttachmentList rows={existing.data.attachments ?? []} />}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================ detail */
export function LabRequestDetailPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can, canAny } = useAuth();
  const q = useQuery({ queryKey: ['lab-request', id], queryFn: async () => (await http.get<{ data: any }>(`/lab/requests/${id}`)).data });
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState<'' | 'return' | 'cancel' | 'close' | 'amend'>('');
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lab-request', id] }); void qc.invalidateQueries({ queryKey: ['lab-requests'] }); };
  const r = q.data;
  if (q.isLoading) return <div className="card"><LoadingBlock /></div>;
  if (q.error || !r) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const act = async (path: string, body?: unknown, msg?: string) => {
    await http.post(`/lab/requests/${id}/${path}`, body); refresh(); if (msg) toast(msg);
  };
  const draft = ['DRAFT', 'CLARIFICATION_REQUIRED'].includes(r.status);
  const closed = ['CANCELLED', 'CLOSED'].includes(r.status);
  return (
    <div>
      <PageHeader title={<span className="flex flex-wrap items-center gap-2">{r.request_no} <LabStatus value={r.status} />{r.priority === 'URGENT' && <Badge tone="red">Urgent</Badge>}</span>}
        breadcrumb={['Lab', 'Requests']}
        subtitle={`${r.buyer_name ?? '—'} · ${r.is_development ? `Development ${r.development_ref ?? ''}` : r.job_no ?? '—'} · ${r.style_code ?? '—'}${r.color_name ? ` · ${r.color_name}` : ''} · due ${fmtDate(r.required_date)}`}
        actions={<>
          {draft && can('LAB.CREATE') && <Button variant="secondary" onClick={() => nav(`/lab/requests/${id}/edit`)}>Edit</Button>}
          {draft && can('LAB.CREATE') && <Button id="lab-req-detail-submit" loading={busy} onClick={async () => { setBusy(true); try { await act('submit', undefined, 'Request submitted'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }}>Submit</Button>}
          {!draft && !closed && can('LAB.CREATE') && <Button variant="secondary" onClick={() => setModal('amend')}>Amend</Button>}
          {r.status === 'SUBMITTED' && can('LAB.APPROVE') && r.samples.length === 0 && <Button variant="secondary" onClick={() => setModal('return')}>Return for info</Button>}
          {!draft && !closed && r.status !== 'APPROVED' && can('LAB.UPDATE') && <Button id="lab-req-inward" variant="secondary" onClick={() => nav(`/lab/samples/inward?request=${id}`)}>Receive sample</Button>}
          {r.samples.length > 0 && !closed && can('LAB.UPDATE') && <Button id="lab-req-new-trial" onClick={() => nav(`/lab/trials/create?request=${id}`)}>New trial</Button>}
          {['APPROVED', 'REJECTED'].includes(r.status) && can('LAB.APPROVE') && <Button variant="secondary" onClick={() => setModal('close')}>Close</Button>}
          {!closed && r.status !== 'APPROVED' && canAny('LAB.CREATE', 'LAB.APPROVE') && <Button variant="danger" onClick={() => setModal('cancel')}>Cancel request</Button>}
        </>} />
      {r.status_reason && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-small text-amber-800">{label(r.status)}: {r.status_reason}</div>}
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'overview', label: 'Overview' }, { key: 'samples', label: 'Samples', count: r.samples.length }, { key: 'trials', label: 'Trials', count: r.trials.length },
        { key: 'reports', label: 'Reports', count: r.reports.length }, { key: 'files', label: 'Attachments', count: r.attachments.length }, { key: 'timeline', label: 'Timeline' }]} />
      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Request" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
              <KV k="Requested" v={`${fmtDate(r.request_date)} by ${r.requester_name ?? '—'}`} /><KV k="Source" v={label(r.source)} /><KV k="Required" v={fmtDate(r.required_date)} />
              <KV k="Buyer" v={r.buyer_name} /><KV k="Order (I/O)" v={r.job_no} /><KV k="Buyer PO" v={r.buyer_po_no} />
              <KV k="Style" v={r.style_code ? `${r.style_code} — ${r.style_name ?? ''}` : null} /><KV k="Colour" v={r.color_name} /><KV k="Descriptor" v={r.item_description} />
              <KV k="Fabric" v={r.fabric_name} /><KV k="Composition / GSM" v={[r.composition, r.gsm ? `${num(r.gsm)} GSM` : ''].filter(Boolean).join(' · ')} /><KV k="Lot" v={r.fabric_lot} />
              <KV k="Scope" v={(r.test_scope ?? []).map(label).join(', ')} /><KV k="Test plan" v={r.plan_code ? `${r.plan_code} v${r.test_plan_version ?? '—'}` : null} /><KV k="Buyer standard" v={r.buyer_standard} />
              {r.is_development ? <KV k="Development" v={`${r.development_ref ?? ''} — ${r.development_reason ?? ''}`} /> : null}
              <KV k="Remarks" v={r.remarks} />
            </div>
          </Card>
          <Card title="Sample requirement">
            <table className="w-full" id="lab-req-req-items">
              <thead><tr><th className="th">Type</th><th className="th text-right">Requested</th><th className="th text-right">Received</th></tr></thead>
              <tbody>{r.items.map((i: any) => (
                <tr key={i.id}><td className="td"><p>{label(i.sample_type)}</p><p className="text-caption text-ink-secondary">{[i.item_description, i.size_label].filter(Boolean).join(' · ')}</p></td>
                  <td className="td text-right tabular-nums">{num(i.requested_qty, 3)} {i.uom}</td>
                  <td className={`td text-right tabular-nums ${Number(i.received_qty) >= Number(i.requested_qty) ? 'text-emerald-700' : 'text-amber-700'}`}>{num(i.received_qty, 3)}</td></tr>
              ))}</tbody>
            </table>
          </Card>
          {r.plan_snapshot && (
            <Card title={`Test plan snapshot — ${r.plan_snapshot.plan_code} v${r.plan_snapshot.version_no}`} className="lg:col-span-3">
              <div className="overflow-x-auto"><table className="w-full">
                <thead><tr><th className="th">Parameter</th><th className="th">Method</th><th className="th">Unit</th><th className="th">Acceptance</th><th className="th text-right">Readings</th><th className="th">Mandatory</th></tr></thead>
                <tbody>{r.plan_snapshot.params.map((p: any) => (
                  <tr key={p.parameter_id}><td className="td">{p.name}</td><td className="td">{p.method_code ?? '—'}</td><td className="td">{p.unit ?? '—'}</td><td className="td">{criteriaText(p)}</td>
                    <td className="td text-right">{p.repeat_count}</td><td className="td">{p.is_mandatory ? 'Yes' : 'No'}</td></tr>
                ))}</tbody>
              </table></div>
            </Card>
          )}
        </div>
      )}
      {tab === 'samples' && (
        <div className="card overflow-x-auto">
          <table className="w-full" id="lab-req-samples">
            <thead><tr><th className="th">Sample ID</th><th className="th">Type</th><th className="th">Received</th><th className="th text-right">Received qty</th><th className="th text-right">Available</th><th className="th text-right">With trials</th><th className="th text-right">Consumed</th><th className="th">Status</th></tr></thead>
            <tbody>
              {r.samples.length === 0 && <tr><td className="td text-center text-ink-muted" colSpan={8}>No sample received yet</td></tr>}
              {r.samples.map((s: any) => (
                <tr key={s.id} className="row-hover">
                  <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/samples/${s.id}`}>{s.sample_no}</Link></td>
                  <td className="td">{label(s.sample_type)}</td><td className="td">{fmtDateTime(s.received_at)}</td>
                  <td className="td text-right tabular-nums">{num(s.received_qty, 3)} {s.uom}</td><td className="td text-right tabular-nums">{num(s.balance.available, 3)}</td>
                  <td className="td text-right tabular-nums">{num(s.balance.outstanding, 3)}</td><td className="td text-right tabular-nums">{num(s.balance.consumed, 3)}</td><td className="td"><LabStatus value={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'trials' && (
        <div className="card overflow-x-auto">
          <table className="w-full" id="lab-req-trials">
            <thead><tr><th className="th">Trial</th><th className="th">Type</th><th className="th">Follows</th><th className="th text-right">Recipe rev</th><th className="th">Technician</th><th className="th">Sample</th><th className="th">Result</th><th className="th">Status</th></tr></thead>
            <tbody>
              {r.trials.length === 0 && <tr><td className="td text-center text-ink-muted" colSpan={8}>No trial yet</td></tr>}
              {r.trials.map((t: any) => (
                <tr key={t.id} className="row-hover">
                  <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/trials/${t.id}`}>{t.trial_no}</Link></td>
                  <td className="td">{label(t.trial_type)}{t.reason ? <p className="text-caption text-ink-secondary">{t.reason}</p> : null}</td>
                  <td className="td">{t.parent_trial_no ?? '—'}</td><td className="td text-right">{t.recipe_revision}</td><td className="td">{t.technician_name}</td><td className="td">{t.sample_no ?? '—'}</td>
                  <td className="td"><ResultBadge value={t.overall_result} /></td><td className="td"><LabStatus value={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'reports' && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead><tr><th className="th">Report</th><th className="th">Trial</th><th className="th">Prepared</th><th className="th">Lab approved</th><th className="th">QA approved</th><th className="th">Result</th><th className="th">Status</th></tr></thead>
            <tbody>
              {r.reports.length === 0 && <tr><td className="td text-center text-ink-muted" colSpan={7}>No report yet</td></tr>}
              {r.reports.map((x: any) => (
                <tr key={x.id} className="row-hover">
                  <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/reports/${x.id}`}>{x.report_no} rev {x.revision_no}</Link></td>
                  <td className="td">{x.trial_no}</td><td className="td">{fmtDateTime(x.prepared_at)}</td><td className="td">{fmtDateTime(x.lab_approved_at)}</td><td className="td">{fmtDateTime(x.qa_approved_at)}</td>
                  <td className="td"><ResultBadge value={x.overall_result} /></td><td className="td"><LabStatus value={x.report_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'files' && (
        <Card title="Attachments" actions={!closed && canAny('LAB.CREATE', 'LAB.UPDATE') && <FilePick id="lab-req-attach" label="Attach buyer protocol"
          onPick={async (f) => { try { await uploadLabFile(f, { request_id: id, attachment_type: 'BUYER_PROTOCOL' }); refresh(); toast('File attached'); } catch (e) { toast(errMsg(e), 'error'); } }} />}>
          <div className="px-4 py-2"><AttachmentList rows={r.attachments} /></div>
        </Card>
      )}
      {tab === 'timeline' && (
        <Card title="Timeline / audit">
          <ul className="divide-y divide-surface-divider" id="lab-req-timeline">
            {r.timeline.map((e: any) => (
              <li key={e.id} className="flex flex-wrap gap-x-3 px-4 py-2 text-small">
                <span className="w-36 shrink-0 text-ink-secondary">{fmtDateTime(e.created_at)}</span>
                <span className="font-medium">{label(e.action)}</span>
                <span className="text-ink-secondary">{label(e.entity_type)} #{e.entity_id}</span>
                <span className="text-ink-secondary">{e.actor}</span>
                {e.remarks && <span className="w-full pl-0 text-ink sm:pl-36">{e.remarks}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ReasonModal open={modal === 'return'} title="Return for missing information" confirm="Return" onClose={() => setModal('')}
        onSubmit={(reason) => act('return', { reason }, 'Request returned')} />
      <ReasonModal open={modal === 'cancel'} title="Cancel the request" confirm="Cancel request" danger onClose={() => setModal('')}
        onSubmit={(reason) => act('cancel', { reason }, 'Request cancelled')} />
      <ReasonModal open={modal === 'close'} title="Close the request" confirm="Close" onClose={() => setModal('')}
        onSubmit={(reason) => act('close', { reason }, 'Request closed')} />
      {modal === 'amend' && <AmendModal r={r} onClose={() => setModal('')} onDone={() => { refresh(); toast('Request amended'); }} />}
    </div>
  );
}

function AmendModal({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const colors = useLookup('colors');
  const [v, setV] = useState({ required_date: String(r.required_date ?? '').slice(0, 10), priority: r.priority, remarks: r.remarks ?? '', buyer_standard: r.buyer_standard ?? '',
    fabric_lot: r.fabric_lot ?? '', color_id: r.color_id ? String(r.color_id) : '', item_description: r.item_description ?? '', amendment_reason: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body: Record<string, unknown> = { amendment_reason: v.amendment_reason, row_version: r.row_version };
      if (v.required_date !== String(r.required_date ?? '').slice(0, 10)) body.required_date = v.required_date;
      if (v.priority !== r.priority) body.priority = v.priority;
      for (const k of ['remarks', 'buyer_standard', 'fabric_lot', 'item_description'] as const) if ((v[k] || null) !== (r[k] ?? null)) body[k] = v[k] || null;
      if ((v.color_id || null) !== (r.color_id ? String(r.color_id) : null)) body.color_id = v.color_id ? Number(v.color_id) : null;
      await http.put(`/lab/requests/${r.id}`, body); onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Amend ${r.request_no}`} subtitle="Controlled fields only; the reason and the old values are kept in the audit trail"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void save()}>Save amendment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Required date" type="date" value={v.required_date} onChange={(e) => setV({ ...v, required_date: e.target.value })} />
        <Select label="Priority" options={opts(['NORMAL', 'URGENT'])} value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} />
        <Select label="Colour" placeholder="—" options={toOptions(colors.data)} value={v.color_id} onChange={(e) => setV({ ...v, color_id: e.target.value })} />
        <Input label="Lot" value={v.fabric_lot} onChange={(e) => setV({ ...v, fabric_lot: e.target.value })} />
        <Input label="Descriptor" value={v.item_description} onChange={(e) => setV({ ...v, item_description: e.target.value })} />
        <Input label="Buyer standard" value={v.buyer_standard} onChange={(e) => setV({ ...v, buyer_standard: e.target.value })} />
        <Textarea label="Remarks" className="sm:col-span-2" value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
        <Textarea label="Amendment reason" required className="sm:col-span-2" value={v.amendment_reason} onChange={(e) => setV({ ...v, amendment_reason: e.target.value })} error={err || undefined} />
      </div>
    </Modal>
  );
}

function criteriaText(p: any) {
  if (p.pass_values) return `Pass: ${p.pass_values}`;
  const has = (x: unknown) => x !== null && x !== undefined;
  if (!has(p.min_value) && !has(p.max_value) && has(p.target_value) && has(p.tolerance)) return `${p.target_value} ± ${p.tolerance}`;
  return has(p.min_value) && has(p.max_value) ? `${p.min_value} to ${p.max_value}` : has(p.min_value) ? `≥ ${p.min_value}` : has(p.max_value) ? `≤ ${p.max_value}` : 'Report only';
}
