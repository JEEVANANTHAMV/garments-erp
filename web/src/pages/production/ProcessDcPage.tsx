import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Printer, Plus, ScanLine, Truck, X, PackageCheck, Ban, Lock, Send } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, StatusBadge, SearchInput, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';

/**
 * Process DCs with bundle numbers (client voice note 1): Stitching / Ironing /
 * Packing and every other job-work DC lists its bundles. Left = bundle
 * picker (filters + scan), right = DC lines grouped colour → size.
 */

type Stage = { id: number; stage_code: string; stage_name: string; kind: string; level: string; source: string };
type Avail = {
  id: number; bundle_no: string; barcode: string; io_no: string; part_name: string; style_code: string;
  color_name: string; size_code: string; size_sort: number; qty: number; status: string; lay_no: string;
  plan_no: string; available_qty: number; open_dc_no: string | null;
};
type Line = Avail & { issue_qty: number };

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'amber', ISSUED: 'blue', PARTIAL_RECEIVED: 'violet', FULLY_RECEIVED: 'green', CLOSED: 'slate', CANCELLED: 'red',
};
const STATUSES = ['DRAFT', 'ISSUED', 'PARTIAL_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'];
const human = (s: string) => s.replace(/_/g, ' ');
const errMsg = (e: any) => e?.message || 'Request failed';

function StatusChip({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value] ?? 'slate'}>{human(value)}</Badge>;
}

/** Group rows colour → size, sizes in size order. */
function groupByColorSize<T extends { color_name: string; size_code: string; size_sort?: number }>(rows: T[]) {
  const colors = new Map<string, Map<string, T[]>>();
  const order = new Map<string, number>();
  for (const r of rows) {
    const c = r.color_name || '—'; const s = r.size_code || '—';
    order.set(s, Number(r.size_sort ?? 0));
    if (!colors.has(c)) colors.set(c, new Map());
    const m = colors.get(c)!;
    if (!m.has(s)) m.set(s, []);
    m.get(s)!.push(r);
  }
  const sizeKeys = [...order.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return [...colors.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([color, m]) => ({
    color,
    sizes: sizeKeys.filter((s) => m.has(s)).map((s) => ({ size: s, rows: m.get(s)! })),
  }));
}

// ════════════════════════════════════════════════════════════════════
// DC list
// ════════════════════════════════════════════════════════════════════
export function ProcessDcPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [stages, setStages] = useState<Stage[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState<number | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [editing, setEditing] = useState<{ id?: number } | null>(null);
  const openId = params.get('dc') ? Number(params.get('dc')) : null;

  const load = () => {
    setLoading(true);
    api.get('/process-dcs', { params: { stage_id: stageFilter || undefined, status: statusFilter || undefined, q: dq || undefined } })
      .then((r) => setRows(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { api.get('/process-dcs/stages').then((r) => setStages(r.data.data || [])); }, []);
  useEffect(load, [stageFilter, statusFilter, dq]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = (m[r.status] || 0) + 1;
    return m;
  }, [rows]);

  const openDc = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('dc', String(id)); else p.delete('dc');
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Process DCs (Job Work)</h1>
          <p className="text-sm text-slate-500">Stitching · Ironing · Packing · Printing DCs with every bundle number, colour and size</p>
        </div>
        <Button onClick={() => setEditing({})}><Plus size={14} className="inline mr-1" />New DC</Button>
      </div>

      {/* Process chips */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setStageFilter('')}
          className={`rounded-full px-3 py-1.5 text-xs font-medium border ${stageFilter === '' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
          All processes
        </button>
        {stages.map((s) => (
          <button key={s.id} onClick={() => setStageFilter(s.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium border ${stageFilter === s.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {s.stage_name}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={setQ} placeholder="DC no or bundle no / barcode…" className="w-72" />
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setStatusFilter('')}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusFilter === '' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
              All {rows.length}
            </button>
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatusFilter(s === statusFilter ? '' : s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusFilter === s ? 'ring-2 ring-brand-500' : ''}`}>
                <StatusChip value={s} /> {statusFilter ? '' : counts[s] ?? 0}
              </button>
            ))}
          </div>
        </div>
        <DataTable
          data={rows}
          loading={loading}
          onRowClick={(r: any) => openDc(r.id)}
          emptyTitle="No DCs yet"
          emptyMessage="Create a DC and pick the bundles going to the vendor."
          columns={[
            { key: 'challan_no', header: 'DC no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.challan_no}</span> },
            { key: 'challan_date', header: 'Date', render: (r: any) => fmtDate(r.challan_date) },
            { key: 'stage_name', header: 'Process', render: (r: any) => r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—' },
            { key: 'vendor_name', header: 'Vendor' },
            { key: 'io_no', header: 'IO / Style', render: (r: any) => <span className="text-xs">{r.io_no ?? '—'}{r.style_code ? ` · ${r.style_code}` : ''}</span> },
            { key: 'bundle_count', header: 'Bundles', align: 'right' as const, render: (r: any) => fmtNumber(r.bundle_count) },
            { key: 'issued_pcs', header: 'Sent (PCS)', align: 'right' as const, render: (r: any) => fmtNumber(r.issued_pcs) },
            { key: 'received_pcs', header: 'Recd (PCS)', align: 'right' as const, render: (r: any) => <span className="text-emerald-700">{fmtNumber(r.received_pcs)}</span> },
            { key: 'pending_pcs', header: 'Pending (PCS)', align: 'right' as const, render: (r: any) => Number(r.pending_pcs) > 0 && !['DRAFT', 'CANCELLED'].includes(r.status) ? <span className="font-semibold text-amber-700">{fmtNumber(r.pending_pcs)}</span> : '—' },
            { key: 'status', header: 'Status', render: (r: any) => <StatusChip value={r.status} /> },
          ]}
        />
      </Card>

      {editing && (
        <DcEditor id={editing.id} stages={stages} onClose={() => setEditing(null)}
          onSaved={(id) => { setEditing(null); load(); openDc(id); }} />
      )}
      {openId && !editing && (
        <DcDetail id={openId} onClose={() => openDc(null)} onChanged={load}
          onEdit={(id) => setEditing({ id })} />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Create / edit (draft) — picker left, DC lines right
// ════════════════════════════════════════════════════════════════════
function DcEditor({ id, stages, onClose, onSaved }: { id?: number; stages: Stage[]; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const vendors = useLookup('vendors');
  const styles = useLookup('styles');
  const colors = useLookup('colors');
  const [head, setHead] = useState<any>({ challan_date: today(), stage_id: '', vendor_id: '', expected_return: '', rate: '', vehicle_no: '', driver_name: '', transporter: '', remarks: '' });
  const [filters, setFilters] = useState<any>({ io_no: '', style_id: '', color_id: '', size: '', q: '' });
  const [avail, setAvail] = useState<Avail[]>([]);
  const [loadingAvail, setLoadingAvail] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState('');
  const [saving, setSaving] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const stage = stages.find((s) => s.id === Number(head.stage_id));

  // Load an existing draft.
  useEffect(() => {
    if (!id) return;
    api.get(`/process-dcs/${id}`).then((r) => {
      const d = r.data.data;
      setHead({
        challan_date: String(d.challan_date).slice(0, 10), stage_id: d.stage_id, vendor_id: d.vendor_id,
        expected_return: d.expected_return ? String(d.expected_return).slice(0, 10) : '', rate: d.rate ?? '',
        vehicle_no: d.vehicle_no ?? '', driver_name: d.driver_name ?? '', transporter: d.transporter ?? '', remarks: d.remarks ?? '',
      });
      setLines(d.lines.map((l: any) => ({
        id: l.bundle_id, bundle_no: l.bundle_no, barcode: l.barcode, io_no: l.bundle_io_no, part_name: l.part,
        style_code: l.style_code, color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort,
        qty: l.bundle_qty, status: l.bundle_status, available_qty: l.qty, issue_qty: l.qty, open_dc_no: null,
      })));
    }).catch((e) => toast(errMsg(e), 'error'));
  }, [id]);

  const loadAvail = () => {
    if (!head.stage_id) { setAvail([]); return; }
    setLoadingAvail(true);
    api.get('/bundle-stock/available', {
      params: {
        stage_id: head.stage_id, io_no: filters.io_no || undefined, style_id: filters.style_id || undefined,
        color_id: filters.color_id || undefined, q: filters.q || undefined,
      },
    }).then((r) => setAvail(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error'))
      .finally(() => setLoadingAvail(false));
  };
  const dFilters = useDebounced(filters, 300);
  useEffect(loadAvail, [head.stage_id, dFilters.io_no, dFilters.style_id, dFilters.color_id, dFilters.q]);

  const inLines = new Set(lines.map((l) => l.id));
  const shown = avail.filter((b) => !inLines.has(b.id) && (!filters.size || b.size_code === filters.size));
  const sizesShown = [...new Set(avail.map((b) => b.size_code))];

  const addBundles = (bs: Avail[]) => {
    const ok = bs.filter((b) => !b.open_dc_no && !inLines.has(b.id));
    const skipped = bs.length - ok.length;
    if (ok.length) setLines((cur) => [...cur, ...ok.map((b) => ({ ...b, issue_qty: b.available_qty }))]);
    if (skipped) toast(`${skipped} bundle(s) skipped — already on another open DC`, 'warning');
    setChecked(new Set());
  };

  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    if (!head.stage_id) { toast('Choose the process first', 'error'); return; }
    if (lines.some((l) => l.barcode === code || l.bundle_no === code)) { toast(`${code} is already on this DC`, 'warning'); setScan(''); return; }
    try {
      const r = await api.get('/bundle-stock/available', { params: { stage_id: head.stage_id, q: code, include_zero: 1 } });
      const hit: Avail | undefined = (r.data.data || []).find((b: Avail) => b.barcode === code || b.bundle_no === code);
      if (!hit) toast(`Bundle ${code} not found`, 'error');
      else if (hit.open_dc_no) toast(`${hit.bundle_no} is already on open DC ${hit.open_dc_no}`, 'error');
      else if (hit.available_qty <= 0) toast(`${hit.bundle_no} has no PCS available for ${stage?.stage_name} (${stage?.source})`, 'error');
      else { addBundles([hit]); toast(`${hit.bundle_no} added — ${hit.available_qty} PCS`); }
    } catch (err) { toast(errMsg(err), 'error'); }
    setScan('');
    scanRef.current?.focus();
  };

  const grouped = groupByColorSize(lines);
  const total = lines.reduce((a, l) => a + (Number(l.issue_qty) || 0), 0);
  const badQty = lines.some((l) => !(l.issue_qty > 0) || l.issue_qty > l.available_qty);

  const save = async (issue: boolean) => {
    if (!head.stage_id || !head.vendor_id) { toast('Choose the process and vendor', 'error'); return; }
    if (!lines.length) { toast('Add at least one bundle', 'error'); return; }
    if (badQty) { toast('Fix the highlighted bundle quantities', 'error'); return; }
    setSaving(true);
    const body = {
      ...head, stage_id: Number(head.stage_id), vendor_id: Number(head.vendor_id),
      rate: head.rate === '' ? null : Number(head.rate), expected_return: head.expected_return || null,
      lines: lines.map((l) => ({ bundle_id: l.id, qty: Number(l.issue_qty) })), issue,
    };
    try {
      const r = id ? await api.put(`/process-dcs/${id}`, body) : await api.post('/process-dcs', body);
      toast(issue ? `DC ${r.data.data.challan_no} issued — ${lines.length} bundles, ${total} PCS` : `Draft ${r.data.data.challan_no} saved`);
      onSaved(r.data.data.id);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={id ? 'Edit draft DC' : 'New process DC'} size="full"
      footer={<>
        <span className="mr-auto self-center text-sm text-slate-600">
          <b>{lines.length}</b> bundles · <b>{fmtNumber(total)}</b> PCS
        </span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" loading={saving} onClick={() => save(false)}>Save draft</Button>
        <Button loading={saving} onClick={() => save(true)}><Send size={13} className="inline mr-1" />Save &amp; issue DC</Button>
      </>}>
      {/* Header */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Select label="Process" required value={head.stage_id}
          onChange={(e) => { setHead({ ...head, stage_id: e.target.value }); if (lines.length) { setLines([]); toast('Process changed — bundle lines cleared', 'info'); } }}
          placeholder="— choose —" options={stages.map((s) => ({ value: s.id, label: s.stage_name }))}
          hint={stage ? `Takes ${stage.source}` : undefined} />
        <Select label="Vendor" required value={head.vendor_id} onChange={(e) => setHead({ ...head, vendor_id: e.target.value })}
          placeholder="— choose —" options={toOptions(vendors.data)} className="md:col-span-2" />
        <Input label="DC date" type="date" required value={head.challan_date} onChange={(e) => setHead({ ...head, challan_date: e.target.value })} />
        <Input label="Expected return" type="date" value={head.expected_return} onChange={(e) => setHead({ ...head, expected_return: e.target.value })} />
        <Input label="Rate (₹ / PCS)" type="number" min={0} step="0.01" value={head.rate} onChange={(e) => setHead({ ...head, rate: e.target.value })} />
        <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value.toUpperCase() })} />
        <Input label="Driver" value={head.driver_name} onChange={(e) => setHead({ ...head, driver_name: e.target.value })} />
        <Input label="Transporter" value={head.transporter} onChange={(e) => setHead({ ...head, transporter: e.target.value })} />
        <Input label="Remarks" value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} className="md:col-span-3" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* LEFT — bundle picker */}
        <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-slate-50/60">
          <div className="border-b border-slate-200 p-3 space-y-2">
            <form onSubmit={onScan} className="flex gap-2">
              <div className="relative flex-1">
                <ScanLine size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-600" />
                <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} disabled={!head.stage_id}
                  placeholder={head.stage_id ? 'Scan bundle barcode + Enter' : 'Choose the process first'}
                  className="input pl-9 font-mono" autoFocus />
              </div>
              <Button type="submit" variant="secondary" disabled={!head.stage_id}>Add</Button>
            </form>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="IO no" value={filters.io_no} onChange={(e) => setFilters({ ...filters, io_no: e.target.value })} />
              <Input placeholder="Bundle no / cut order" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
              <Select value={filters.style_id} onChange={(e) => setFilters({ ...filters, style_id: e.target.value })}
                placeholder="All styles" options={toOptions(styles.data)} />
              <Select value={filters.color_id} onChange={(e) => setFilters({ ...filters, color_id: e.target.value })}
                placeholder="All colours" options={toOptions(colors.data)} />
            </div>
            {sizesShown.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {['', ...sizesShown].map((sz) => (
                  <button key={sz || 'all'} onClick={() => setFilters({ ...filters, size: sz })}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${filters.size === sz ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}`}>
                    {sz || 'All sizes'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
            <span>{loadingAvail ? 'Loading…' : `${shown.length} bundles available`}</span>
            <div className="flex gap-2">
              <button className="font-semibold text-brand-700 disabled:opacity-40" disabled={!shown.length}
                onClick={() => addBundles(shown)}>Add all shown</button>
              <button className="font-semibold text-brand-700 disabled:opacity-40" disabled={!checked.size}
                onClick={() => addBundles(shown.filter((b) => checked.has(b.id)))}>Add selected ({checked.size})</button>
            </div>
          </div>
          <div className="max-h-[52vh] overflow-y-auto px-3 pb-3 space-y-3">
            {!head.stage_id && <p className="py-8 text-center text-sm text-slate-400">Choose the process to see bundles ready for it.</p>}
            {groupByColorSize(shown).map((g) => (
              <div key={g.color}>
                <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{g.color}</p>
                {g.sizes.map((sz) => (
                  <div key={sz.size} className="mb-2 rounded-lg border border-slate-200 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 px-2.5 py-1 text-xs">
                      <span className="font-semibold text-slate-700">Size {sz.size}</span>
                      <span className="text-slate-400">{sz.rows.length} bundles · {fmtNumber(sz.rows.reduce((a, b) => a + b.available_qty, 0))} PCS</span>
                    </div>
                    {sz.rows.map((b) => (
                      <label key={b.id} className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-brand-50/40 ${b.open_dc_no ? 'opacity-50' : ''}`}>
                        <input type="checkbox" disabled={!!b.open_dc_no} checked={checked.has(b.id)}
                          onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(b.id); else n.delete(b.id); setChecked(n); }} />
                        <span className="font-mono font-semibold text-slate-800">{b.bundle_no}</span>
                        <span className="text-slate-400">{b.part_name}</span>
                        {b.open_dc_no && <Badge tone="amber">on {b.open_dc_no}</Badge>}
                        <span className="ml-auto font-semibold text-slate-700">{b.available_qty} PCS</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — DC lines grouped colour → size */}
        <div className="lg:col-span-3 rounded-xl border border-slate-200">
          <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
            <span className="text-sm font-semibold text-slate-800">DC lines — {lines.length} bundles · {fmtNumber(total)} PCS</span>
            {lines.length > 0 && <button className="text-xs text-red-600" onClick={() => setLines([])}>Clear all</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-3 space-y-3">
            {!lines.length && <p className="py-16 text-center text-sm text-slate-400">Scan bundles or pick them on the left.</p>}
            {grouped.map((g) => {
              const cTotal = g.sizes.reduce((a, s) => a + s.rows.reduce((x, l) => x + (Number(l.issue_qty) || 0), 0), 0);
              const cCount = g.sizes.reduce((a, s) => a + s.rows.length, 0);
              return (
                <div key={g.color} className="rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between bg-slate-800 px-3 py-1.5 text-xs text-white rounded-t-lg">
                    <span className="font-bold uppercase tracking-wide">{g.color}</span>
                    <span>{cCount} bundles · <b>{fmtNumber(cTotal)} PCS</b></span>
                  </div>
                  {g.sizes.map((sz) => (
                    <div key={sz.size} className="border-t border-slate-100">
                      <div className="flex items-center justify-between bg-slate-50 px-3 py-1 text-xs">
                        <span className="font-semibold text-slate-700">Size {sz.size}</span>
                        <span className="text-slate-500">{sz.rows.length} bundles · {fmtNumber(sz.rows.reduce((a, l) => a + (Number(l.issue_qty) || 0), 0))} PCS</span>
                      </div>
                      <table className="w-full text-xs">
                        <tbody>
                          {sz.rows.map((l) => {
                            const bad = !(l.issue_qty > 0) || l.issue_qty > l.available_qty;
                            return (
                              <tr key={l.id} className="border-t border-slate-50">
                                <td className="px-3 py-1 font-mono font-semibold text-slate-800">{l.bundle_no}</td>
                                <td className="px-2 py-1 text-slate-500">{l.part_name}</td>
                                <td className="px-2 py-1 text-slate-400">{l.io_no}</td>
                                <td className="px-2 py-1 text-right text-slate-400">avail {l.available_qty} PCS</td>
                                <td className="w-28 px-2 py-1">
                                  <div className="flex items-center gap-1">
                                    <input type="number" min={1} max={l.available_qty} value={l.issue_qty}
                                      onChange={(e) => setLines((cur) => cur.map((x) => x.id === l.id ? { ...x, issue_qty: Number(e.target.value) } : x))}
                                      className={`input h-7 w-16 px-1.5 text-right ${bad ? 'input-error' : ''}`} />
                                    <span className="text-[10px] text-slate-400">PCS</span>
                                  </div>
                                </td>
                                <td className="w-8 px-1">
                                  <button onClick={() => setLines((cur) => cur.filter((x) => x.id !== l.id))} className="text-slate-400 hover:text-red-600" aria-label="Remove">
                                    <X size={14} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              );
            })}
            {lines.length > 0 && <SizeColorMatrix rows={lines.map((l) => ({ color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort, qty: Number(l.issue_qty) || 0 }))} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Colour × size PCS matrix with totals. */
function SizeColorMatrix({ rows }: { rows: { color_name: string; size_code: string; size_sort?: number; qty: number }[] }) {
  const g = groupByColorSize(rows);
  const sizes = [...new Map(rows.map((r) => [r.size_code, Number(r.size_sort ?? 0)])).entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const cell = (c: string, s: string) => g.find((x) => x.color === c)?.sizes.find((x) => x.size === s)?.rows ?? [];
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-1.5 text-left">Colour \ Size (PCS)</th>
            {sizes.map((s) => <th key={s} className="px-2 py-1.5 text-right">{s}</th>)}
            <th className="px-3 py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {g.map((c) => (
            <tr key={c.color} className="border-t border-slate-100">
              <td className="px-3 py-1 font-semibold">{c.color}</td>
              {sizes.map((s) => {
                const r = cell(c.color, s);
                return <td key={s} className="px-2 py-1 text-right">{r.length ? <>{fmtNumber(r.reduce((a, x) => a + x.qty, 0))} <span className="text-slate-400">({r.length})</span></> : '—'}</td>;
              })}
              <td className="px-3 py-1 text-right font-bold">{fmtNumber(c.sizes.reduce((a, s) => a + s.rows.reduce((x, y) => x + y.qty, 0), 0))}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
            <td className="px-3 py-1">Total</td>
            {sizes.map((s) => <td key={s} className="px-2 py-1 text-right">{fmtNumber(rows.filter((r) => r.size_code === s).reduce((a, r) => a + r.qty, 0))}</td>)}
            <td className="px-3 py-1 text-right">{fmtNumber(rows.reduce((a, r) => a + r.qty, 0))}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-3 py-1 text-[10px] text-slate-400">(n) = number of bundles</p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// DC detail: lines, receipts, actions, print
// ════════════════════════════════════════════════════════════════════
function DcDetail({ id, onClose, onChanged, onEdit }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (id: number) => void }) {
  const toast = useToast();
  const [dc, setDc] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [reasonFor, setReasonFor] = useState<'cancel' | 'close' | null>(null);
  const [reason, setReason] = useState('');

  const load = () => api.get(`/process-dcs/${id}`).then((r) => setDc(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [id]);

  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); if (r?.data?.data?.lines) setDc(r.data.data); else await load(); toast(msg); onChanged(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  if (!dc) return <Modal open onClose={onClose} title="DC"><p className="text-sm text-slate-500">Loading…</p></Modal>;
  const grouped = groupByColorSize(dc.lines as any[]);
  const canReceive = ['ISSUED', 'PARTIAL_RECEIVED'].includes(dc.status);

  return (
    <Modal open onClose={onClose} size="xl" title={`${dc.stage_name ?? 'Job work'} DC ${dc.challan_no}`}
      footer={<>
        <div className="mr-auto flex gap-2">
          {['DRAFT', 'ISSUED'].includes(dc.status) && (
            <Button variant="danger" disabled={busy} onClick={() => { setReason(''); setReasonFor('cancel'); }}><Ban size={13} className="inline mr-1" />Cancel DC</Button>
          )}
          {canReceive && (
            <Button variant="secondary" disabled={busy} onClick={() => { setReason(''); setReasonFor('close'); }}><Lock size={13} className="inline mr-1" />Close short</Button>
          )}
        </div>
        <Button variant="secondary" onClick={() => printDc(id, toast)}><Printer size={13} className="inline mr-1" />Print DC</Button>
        {dc.status === 'DRAFT' && <Button variant="secondary" onClick={() => onEdit(id)}>Edit draft</Button>}
        {dc.status === 'DRAFT' && (
          <Button loading={busy} onClick={() => act(() => api.post(`/process-dcs/${id}/issue`), `DC ${dc.challan_no} issued`)}>
            <Send size={13} className="inline mr-1" />Issue DC
          </Button>
        )}
        {canReceive && <Button onClick={() => setReceiving(true)}><PackageCheck size={13} className="inline mr-1" />Receive</Button>}
      </>}>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Info label="Status"><StatusChip value={dc.status} /></Info>
        <Info label="Vendor">{dc.vendor_name}</Info>
        <Info label="DC date">{fmtDate(dc.challan_date)}</Info>
        <Info label="Expected return">{fmtDate(dc.expected_return)}</Info>
        <Info label="IO / Style">{dc.io_no ?? '—'}{dc.style_code ? ` · ${dc.style_code}` : ''}</Info>
        <Info label="Vehicle / driver">{dc.vehicle_no ?? '—'}{dc.driver_name ? ` · ${dc.driver_name}` : ''}</Info>
        <Info label="Issued">{dc.issued_at ? `${fmtDateTime(dc.issued_at)} · ${dc.issued_by_name ?? ''}` : '—'}</Info>
        <Info label="Rate">{dc.rate != null ? `₹${Number(dc.rate).toFixed(2)} / PCS` : '—'}</Info>
      </div>
      {(dc.cancel_reason || dc.close_reason) && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {dc.cancel_reason ? `Cancelled: ${dc.cancel_reason}` : `Closed short: ${dc.close_reason}`}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        <Kpi label="Bundles" value={dc.summary.totals.bundles} />
        <Kpi label="Sent" value={dc.summary.totals.qty} unit="PCS" />
        <Kpi label="Received good" value={dc.summary.totals.received} unit="PCS" tone="text-emerald-700" />
        <Kpi label="Reject + shortage" value={dc.summary.totals.rejected + dc.summary.totals.shortage} unit="PCS" tone="text-red-600" />
        <Kpi label="Pending" value={['DRAFT', 'CANCELLED'].includes(dc.status) ? 0 : dc.summary.totals.pending} unit="PCS" tone="text-amber-700" />
      </div>

      <div className="mt-4 space-y-3">
        {grouped.map((g) => (
          <div key={g.color} className="rounded-lg border border-slate-200">
            <div className="flex justify-between rounded-t-lg bg-slate-800 px-3 py-1.5 text-xs text-white">
              <span className="font-bold uppercase">{g.color}</span>
              <span>{g.sizes.reduce((a, s) => a + s.rows.length, 0)} bundles · <b>{fmtNumber(g.sizes.reduce((a, s) => a + s.rows.reduce((x: number, l: any) => x + Number(l.qty), 0), 0))} PCS</b></span>
            </div>
            {g.sizes.map((sz) => (
              <div key={sz.size} className="border-t border-slate-100 px-3 py-2">
                <div className="mb-1 flex justify-between text-xs">
                  <span className="font-semibold">Size {sz.size}</span>
                  <span className="text-slate-500">{sz.rows.length} bundles · {fmtNumber(sz.rows.reduce((a: number, l: any) => a + Number(l.qty), 0))} PCS</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {sz.rows.map((l: any) => (
                    <Link key={l.id} to={`/production/traceability?bundle=${encodeURIComponent(l.barcode ?? l.bundle_no)}`}
                      title={`Recd ${l.received_qty} · Rej ${l.rejected_qty} · Short ${l.shortage_qty} · Pending ${l.pending_qty}`}
                      className={`rounded border px-2 py-0.5 font-mono text-[11px] ${Number(l.pending_qty) === 0 && dc.status !== 'DRAFT' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-700'} hover:border-brand-400`}>
                      {l.bundle_no} <b>{l.qty}</b>
                      {Number(l.received_qty) > 0 && <span className="text-emerald-700"> ✓{l.received_qty}</span>}
                      {Number(l.rejected_qty) + Number(l.shortage_qty) > 0 && <span className="text-red-600"> ✗{Number(l.rejected_qty) + Number(l.shortage_qty)}</span>}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
        {dc.lines.length > 0 && <SizeColorMatrix rows={dc.lines.map((l: any) => ({ color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort, qty: Number(l.qty) }))} />}
      </div>

      {dc.receipts.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1 text-sm font-semibold text-slate-700">Receipts</h4>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left">Receipt</th><th className="px-2 py-1 text-left">Date</th>
              <th className="px-2 py-1 text-right">Good (PCS)</th><th className="px-2 py-1 text-right">Reject (PCS)</th>
              <th className="px-2 py-1 text-right">Shortage (PCS)</th><th className="px-2 py-1 text-left">By</th><th className="px-2 py-1 text-left">Remarks</th>
            </tr></thead>
            <tbody>
              {dc.receipts.map((r: any) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{r.receipt_no}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
                  <td className="px-2 py-1 text-right text-emerald-700">{fmtNumber(r.received_qty)}</td>
                  <td className="px-2 py-1 text-right text-red-600">{fmtNumber(r.rejected_qty)}</td>
                  <td className="px-2 py-1 text-right text-orange-600">{fmtNumber(r.shortage_qty)}</td>
                  <td className="px-2 py-1">{r.created_by_name}</td><td className="px-2 py-1">{r.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {receiving && <ReceiveModal dc={dc} onClose={() => setReceiving(false)} onDone={(d) => { setReceiving(false); setDc(d); onChanged(); }} />}
      {reasonFor && (
        <Modal open onClose={() => setReasonFor(null)} size="sm" title={reasonFor === 'cancel' ? `Cancel DC ${dc.challan_no}` : `Close DC ${dc.challan_no} short`}
          footer={<>
            <Button variant="secondary" onClick={() => setReasonFor(null)}>Back</Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3}
              onClick={() => { const f = reasonFor; setReasonFor(null); act(() => api.post(`/process-dcs/${id}/${f}`, { reason }), f === 'cancel' ? 'DC cancelled' : 'DC closed — pending PCS written off as shortage'); }}>
              Confirm
            </Button>
          </>}>
          <p className="mb-2 text-xs text-slate-600">
            {reasonFor === 'cancel'
              ? 'The DC stays on record as CANCELLED and every bundle quantity returns to where it came from.'
              : `Every pending PCS (${dc.summary.totals.pending} PCS) is written off as vendor shortage against its bundle.`}
          </p>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </Modal>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p><div className="font-medium text-slate-800">{children}</div></div>;
}
function Kpi({ label, value, unit, tone }: { label: string; value: number; unit?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${tone ?? 'text-slate-800'}`}>{fmtNumber(value)} {unit && <span className="text-xs font-medium text-slate-400">{unit}</span>}</p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Receipt against DC (per bundle good / reject / shortage)
// ════════════════════════════════════════════════════════════════════
function ReceiveModal({ dc, onClose, onDone }: { dc: any; onClose: () => void; onDone: (dc: any) => void }) {
  const toast = useToast();
  const open = (dc.lines as any[]).filter((l) => Number(l.pending_qty) > 0);
  const [rows, setRows] = useState<Record<number, { g: number; r: number; s: number }>>(
    Object.fromEntries(open.map((l) => [l.id, { g: 0, r: 0, s: 0 }])));
  const [date, setDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [scan, setScan] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (id: number, k: 'g' | 'r' | 's', v: number) => setRows((cur) => ({ ...cur, [id]: { ...cur[id], [k]: Math.max(0, v || 0) } }));
  const onScan = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    const l = open.find((x) => x.barcode === code || x.bundle_no === code);
    if (!l) toast(`${code} is not pending on this DC`, 'error');
    else { set(l.id, 'g', Number(l.pending_qty) - rows[l.id].r - rows[l.id].s); toast(`${l.bundle_no}: ${l.pending_qty} PCS good`); }
    setScan('');
  };
  const tot = Object.values(rows).reduce((a, x) => ({ g: a.g + x.g, r: a.r + x.r, s: a.s + x.s }), { g: 0, r: 0, s: 0 });
  const over = open.some((l) => rows[l.id].g + rows[l.id].r + rows[l.id].s > Number(l.pending_qty));

  const save = async () => {
    const lines = open.filter((l) => rows[l.id].g + rows[l.id].r + rows[l.id].s > 0)
      .map((l) => ({ line_id: l.id, received_qty: rows[l.id].g, rejected_qty: rows[l.id].r, shortage_qty: rows[l.id].s }));
    if (!lines.length) { toast('Enter quantities for at least one bundle', 'error'); return; }
    setSaving(true);
    try {
      const r = await api.post(`/process-dcs/${dc.id}/receipts`, { receipt_date: date, remarks: remarks || null, lines });
      toast(`Receipt ${r.data.data.receipt_no} saved — DC ${human(r.data.data.dc_status)}`);
      onDone(r.data.data.dc);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title={`Receive against ${dc.challan_no} — ${dc.vendor_name}`}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-600">Good <b>{tot.g}</b> · Reject <b>{tot.r}</b> · Shortage <b>{tot.s}</b> PCS</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={over} onClick={save}>Save receipt</Button>
      </>}>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        <Input label="Receipt date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Input label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} className="md:col-span-2" />
      </div>
      <div className="mb-2 flex items-center gap-2">
        <form onSubmit={onScan} className="relative flex-1">
          <ScanLine size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-600" />
          <input value={scan} onChange={(e) => setScan(e.target.value)} className="input pl-9 font-mono" placeholder="Scan returned bundle — fills pending as good" autoFocus />
        </form>
        <Button variant="secondary" onClick={() => setRows(Object.fromEntries(open.map((l) => [l.id, { g: Number(l.pending_qty), r: 0, s: 0 }])))}>All pending good</Button>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="px-2 py-1 text-left">Bundle</th><th className="px-2 py-1 text-left">Colour / Size</th>
          <th className="px-2 py-1 text-right">Pending (PCS)</th><th className="px-2 py-1 text-right">Good (PCS)</th>
          <th className="px-2 py-1 text-right">Reject (PCS)</th><th className="px-2 py-1 text-right">Shortage (PCS)</th>
        </tr></thead>
        <tbody>
          {open.map((l) => {
            const x = rows[l.id]; const bad = x.g + x.r + x.s > Number(l.pending_qty);
            return (
              <tr key={l.id} className={`border-t border-slate-100 ${bad ? 'bg-red-50' : ''}`}>
                <td className="px-2 py-1 font-mono font-semibold">{l.bundle_no}</td>
                <td className="px-2 py-1">{l.color_name} / {l.size_code}</td>
                <td className="px-2 py-1 text-right font-semibold">{l.pending_qty}</td>
                {(['g', 'r', 's'] as const).map((k) => (
                  <td key={k} className="px-2 py-1 text-right">
                    <input type="number" min={0} value={x[k]} onChange={(e) => set(l.id, k, Number(e.target.value))} className="input h-7 w-16 px-1.5 text-right" />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
// DC print — challan listing bundle numbers grouped by colour / size
// ════════════════════════════════════════════════════════════════════
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function printDc(id: number, toast: (m: string, k?: any) => void) {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) { toast('Allow pop-ups to print the DC', 'error'); return; }
  try {
    const d = (await api.get(`/process-dcs/${id}/print`)).data.data;
    const c = d.company ?? {}; const va = d.vendor_address ?? {};
    const groups = groupByColorSize(d.lines as any[]);
    const sizes: string[] = d.summary.sizes;
    const body = groups.map((g) => {
      const rows = g.sizes.map((s) => {
        const qty = s.rows.reduce((a: number, l: any) => a + Number(l.qty), 0);
        return `<tr><td>${esc(s.size)}</td><td class="bundles">${s.rows.map((l: any) => `${esc(l.bundle_no)} <small>(${l.qty})</small>`).join(', ')}</td>
          <td class="r">${s.rows.length}</td><td class="r">${qty}</td></tr>`;
      }).join('');
      const cq = g.sizes.reduce((a, s) => a + s.rows.reduce((x: number, l: any) => x + Number(l.qty), 0), 0);
      const cb = g.sizes.reduce((a, s) => a + s.rows.length, 0);
      return `<tr class="grp"><td colspan="4">${esc(g.color)}</td></tr>${rows}
        <tr class="sub"><td colspan="2">Total ${esc(g.color)}</td><td class="r">${cb}</td><td class="r">${cq}</td></tr>`;
    }).join('');
    const matrix = `<table class="grid"><thead><tr><th>Colour \\ Size</th>${sizes.map((s) => `<th class="r">${esc(s)}</th>`).join('')}<th class="r">Total PCS</th></tr></thead><tbody>
      ${d.summary.colors.map((cl: any) => `<tr><td>${esc(cl.color_name)}</td>${cl.sizes.map((z: any) => `<td class="r">${z.qty || '—'}</td>`).join('')}<td class="r"><b>${cl.qty}</b></td></tr>`).join('')}
      <tr class="sub"><td>Total</td>${d.summary.sizeTotals.map((z: any) => `<td class="r">${z.qty}</td>`).join('')}<td class="r">${d.summary.totals.qty}</td></tr></tbody></table>`;
    w.document.write(`<!doctype html><html><head><title>${esc(d.challan_no)}</title><style>
      body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:18px}
      h1{font-size:16px;margin:0} h2{font-size:13px;margin:6px 0;text-align:center;letter-spacing:1px}
      table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #444;padding:3px 5px;vertical-align:top}
      th{background:#eee;text-align:left} .r{text-align:right} .grp td{background:#222;color:#fff;font-weight:bold;text-transform:uppercase}
      .sub td{background:#f2f2f2;font-weight:bold} .bundles{font-family:monospace;font-size:10.5px} small{color:#555}
      .hdr{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:6px}
      .meta td{border:none;padding:2px 4px} .sign{display:flex;justify-content:space-between;margin-top:48px}
      .sign div{border-top:1px solid #111;width:30%;text-align:center;padding-top:4px} .note{font-size:10px;margin-top:8px}
      @media print{button{display:none}}
    </style></head><body>
      <div class="hdr"><div><h1>${esc(c.legal_name || c.trade_name)}</h1>
        <div>${esc([c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', '))}</div>
        <div>GSTIN: ${esc(c.gstin || '—')} · Ph: ${esc(c.phone || '—')}</div></div>
        <div style="text-align:right"><b>DC No: ${esc(d.challan_no)}</b><br/>Date: ${esc(fmtDate(d.challan_date))}<br/>Status: ${esc(human(d.status))}</div></div>
      <h2>DELIVERY CHALLAN — JOB WORK (${esc(String(d.stage_name || '').toUpperCase())})</h2>
      <table class="meta"><tr>
        <td style="width:50%"><b>To (Job worker):</b> ${esc(d.vendor_name)} (${esc(d.vendor_code || '')})<br/>
          ${esc([va.address_line1, va.address_line2, va.address_line3, va.city, va.state, va.pincode].filter(Boolean).join(', '))}<br/>
          GSTIN: ${esc(d.vendor_gstin || '—')} · Ph: ${esc(va.mobile || va.phone || d.vendor_phone || '—')}</td>
        <td><b>Process:</b> ${esc(d.stage_name)}<br/><b>IO / Style:</b> ${esc(d.io_no || '—')} ${esc(d.style_code || '')}<br/>
          <b>Vehicle:</b> ${esc(d.vehicle_no || '—')} · <b>Driver:</b> ${esc(d.driver_name || '—')}<br/>
          <b>Transporter:</b> ${esc(d.transporter || '—')} · <b>Expected return:</b> ${esc(fmtDate(d.expected_return))}</td>
      </tr></table>
      <table><thead><tr><th style="width:10%">Size</th><th>Bundle numbers (PCS)</th><th class="r" style="width:9%">Bundles</th><th class="r" style="width:10%">PCS</th></tr></thead>
        <tbody>${body}<tr class="sub"><td colspan="2">GRAND TOTAL</td><td class="r">${d.summary.totals.bundles}</td><td class="r">${d.summary.totals.qty}</td></tr></tbody></table>
      ${matrix}
      <p class="note">Goods sent for job work and to be returned after processing — not for sale. ${esc(d.remarks || '')}</p>
      <div class="sign"><div>Prepared by</div><div>Checked / Security</div><div>Receiver's signature &amp; seal</div></div>
      <button onclick="window.print()" style="margin-top:16px">Print</button>
    </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  } catch (e) { w.close(); toast(errMsg(e), 'error'); }
}

// ════════════════════════════════════════════════════════════════════
// Receipts register (read-only; receipts are posted from the DC)
// ════════════════════════════════════════════════════════════════════
export function ProcessDcReceiptsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api.get('/process-dcs/receipts').then((r) => setRows(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  }, []);
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Job Work Receipts</h1>
          <p className="text-sm text-slate-500">Goods received back against process DCs — post new receipts from the DC (Receive)</p>
        </div>
        <Link to="/production/jobwork-challans" className="btn-primary"><Truck size={14} className="inline mr-1" />Go to DCs</Link>
      </div>
      <Card>
        <DataTable data={rows} loading={loading} emptyTitle="No receipts yet"
          columns={[
            { key: 'receipt_no', header: 'Receipt no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.receipt_no}</span> },
            { key: 'receipt_date', header: 'Date', render: (r: any) => fmtDate(r.receipt_date) },
            { key: 'challan_no', header: 'DC', render: (r: any) => <Link className="font-mono text-brand-700 hover:underline" to={`/production/jobwork-challans?dc=${r.challan_id}`}>{r.challan_no}</Link> },
            { key: 'stage_name', header: 'Process', render: (r: any) => r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—' },
            { key: 'vendor_name', header: 'Vendor' },
            { key: 'line_count', header: 'Bundles', align: 'right' as const },
            { key: 'received_qty', header: 'Good (PCS)', align: 'right' as const, render: (r: any) => <span className="text-emerald-700">{fmtNumber(r.received_qty)}</span> },
            { key: 'rejected_qty', header: 'Reject (PCS)', align: 'right' as const, render: (r: any) => Number(r.rejected_qty) ? <span className="text-red-600">{fmtNumber(r.rejected_qty)}</span> : '—' },
            { key: 'shortage_qty', header: 'Shortage (PCS)', align: 'right' as const, render: (r: any) => Number(r.shortage_qty) ? <span className="text-orange-600">{fmtNumber(r.shortage_qty)}</span> : '—' },
            { key: 'dc_status', header: 'DC status', render: (r: any) => <StatusBadge value={r.dc_status} /> },
          ]} />
      </Card>
    </div>
  );
}
