import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Save, X, Eye, Trash2, Shirt, Factory, ShieldCheck, Boxes, PackageCheck,
  Warehouse,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import {
  Modal, PageHeader, Input, Select, Textarea, LoadingBlock, EmptyState,
  SearchInput, Badge, Pager,
} from '../../components/ui';

/**
 * Collar Knitting (doc §16, §17).
 *
 * Output is counted in PCS while yarn is consumed in KG. The standard weight
 * per piece only drives planning; the actual gm/pc shown here is always derived
 * from actual KG ÷ actual PCS, never from a fixed conversion factor.
 */

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', STOCK_CHECK: 'sky', RESERVED: 'indigo', RELEASED: 'violet',
  MATERIAL_ISSUED: 'amber', IN_PROGRESS: 'amber', PRODUCTION_COMPLETED: 'emerald',
  OUTPUT_RECEIPT: 'emerald', QC: 'sky', STOCK_POSTED: 'emerald',
  COMPLETED: 'emerald', CANCELLED: 'rose',
};

let _sq = 0;
interface SizeRow {
  _key: string;
  size_id: number | '';
  size_code: string;
  std_weight_gm: number | '';
  planned_pcs: number | '';
}
const newSize = (): SizeRow => ({
  _key: `z${++_sq}`, size_id: '', size_code: '', std_weight_gm: '', planned_pcs: '',
});

const emptyForm = {
  program_date: today(), so_line_id: '' as number | '', io_no: '', buyer_po_no: '',
  style_id: '' as number | '', part_name: 'COLLAR', collar_id: '' as number | '',
  collar_type: '', colour: '', yarn_id: '' as number | '', gauge_needle: '',
  required_date: '', job_work_type: 'INTERNAL', vendor_id: '' as number | '',
  status: 'DRAFT', remarks: '', sizes: [] as SizeRow[],
};

export default function CollarKnittingPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [prodFor, setProdFor] = useState<any | null>(null);
  const [rcptFor, setRcptFor] = useState<any | null>(null);

  const lk = (name: string) => useQuery({
    queryKey: ['lookups', name],
    queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${name}`)).data || [],
  });
  const { data: yarns = [] } = lk('yarns');
  const { data: styles = [] } = lk('styles');
  const { data: parties = [] } = lk('parties');
  const { data: sizes = [] } = lk('sizes-all');
  const { data: soLines = [] } = lk('sales-order-lines');
  const { data: warehouses = [] } = lk('warehouses');

  const { data: collars = [] } = useQuery({
    queryKey: ['collars'],
    queryFn: async () => (await http.get<{ data: any[] }>('/collars')).data || [],
  });

  const { data: listRes, isLoading, refetch } = useQuery({
    queryKey: ['collar-programs', statusFilter, search, page],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (statusFilter !== 'ALL') p.set('status', statusFilter);
      if (search) p.set('q', search);
      return await http.get<{ data: any[]; pagination: any }>(`/collar-programs?${p}`);
    },
  });
  const rows = listRes?.data ?? [];
  const pagination = listRes?.pagination;

  const { data: detail } = useQuery({
    queryKey: ['collar-program', detailId],
    queryFn: async () => (await http.get<{ data: any }>(`/collar-programs/${detailId}`)).data,
    enabled: detailId != null,
  });

  const setF = (k: string, v: any) => setForm((s) => ({ ...s, [k]: v }));
  const setSize = (key: string, patch: Partial<SizeRow>) =>
    setForm((s) => ({ ...s, sizes: s.sizes.map((z) => (z._key === key ? { ...z, ...patch } : z)) }));

  // Planning totals, mirroring the server so the planner sees them live.
  const totals = form.sizes.reduce(
    (acc, z) => {
      const kg = ((Number(z.planned_pcs) || 0) * (Number(z.std_weight_gm) || 0)) / 1000;
      return { pcs: acc.pcs + (Number(z.planned_pcs) || 0), kg: acc.kg + kg };
    }, { pcs: 0, kg: 0 });

  const onSoLine = (value: string) => {
    const l = soLines.find((x: any) => x.id === Number(value));
    setForm((s) => ({
      ...s, so_line_id: value === '' ? '' : Number(value),
      style_id: l?.style_id ?? s.style_id, part_name: l?.part_name ?? s.part_name,
    }));
  };

  const onCollarSelect = (value: string) => {
    const c = collars.find((x: any) => x.id === Number(value));
    setForm((s) => ({
      ...s, collar_id: value === '' ? '' : Number(value),
      collar_type: c?.collar_type ?? s.collar_type,
      colour: c?.colour ?? s.colour,
      yarn_id: c?.yarn_id ?? s.yarn_id,
    }));
  };

  const save = async () => {
    if (!form.yarn_id) { toast('Select a yarn', 'error'); return; }
    if (!form.sizes.length) { toast('Add at least one size row', 'error'); return; }

    setSaving(true);
    try {
      await http.post('/collar-programs', {
        program_date: form.program_date,
        so_line_id: form.so_line_id === '' ? null : Number(form.so_line_id),
        io_no: form.io_no || null, buyer_po_no: form.buyer_po_no || null,
        style_id: form.style_id === '' ? null : Number(form.style_id),
        part_name: form.part_name || null,
        collar_id: form.collar_id === '' ? null : Number(form.collar_id),
        collar_type: form.collar_type || null, colour: form.colour || null,
        yarn_id: Number(form.yarn_id), gauge_needle: form.gauge_needle || null,
        required_date: form.required_date || null,
        job_work_type: form.job_work_type,
        vendor_id: form.vendor_id === '' ? null : Number(form.vendor_id),
        status: form.status, remarks: form.remarks || null,
        sizes: form.sizes.map((z) => ({
          size_id: z.size_id === '' ? null : Number(z.size_id),
          size_code: z.size_code || null,
          std_weight_gm: Number(z.std_weight_gm) || 0,
          planned_pcs: Number(z.planned_pcs) || 0,
        })),
      });
      toast('Collar program created');
      setOpen(false); setForm({ ...emptyForm });
      void qc.invalidateQueries({ queryKey: ['collar-programs'] });
    } catch (e: any) {
      toast(e?.message || 'Could not create the program', 'error');
    } finally { setSaving(false); }
  };

  const act = async (id: number, action: string, label: string) => {
    try {
      const r = await http.post<any>(`/collar-programs/${id}/${action}`, {});
      if (action === 'check-stock') {
        const short = (r.data ?? []).filter((x: any) => Number(x.shortage_kg) > 0);
        toast(
          short.length ? `Shortage: ${short.map((x: any) => `${x.shortage_kg} KG`).join(', ')}`
                       : 'Stock is sufficient',
          short.length ? 'error' : 'success');
      } else toast(label);
      void qc.invalidateQueries({ queryKey: ['collar-programs'] });
      void qc.invalidateQueries({ queryKey: ['collar-program'] });
    } catch (e: any) { toast(e?.message || `Could not ${label.toLowerCase()}`, 'error'); }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Collar Knitting"
        subtitle="Size-wise planning in PCS against yarn consumed in KG — actual weight is derived from production"
        actions={
          <button className="btn-primary" onClick={() => { setForm({ ...emptyForm, sizes: [newSize()] }); setOpen(true); }}
            id="btn-new-collar-prog">
            <Plus size={15} /> New Program
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-44" value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} id="cf-status">
          <option value="ALL">All statuses</option>
          {Object.keys(STATUS_TONE).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }}
          placeholder="Search program no or I/O…" />
        <button className="btn-secondary" onClick={() => void refetch()}>Refresh</button>
      </div>

      {isLoading ? <LoadingBlock label="Loading collar programs…" /> : rows.length === 0 ? (
        <EmptyState icon={<Shirt size={22} />} title="No collar programs yet"
          message="Create a program to plan collars size-wise in pieces." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th text-left">Program No</th>
                  <th className="th text-left">Date</th>
                  <th className="th text-left">Style</th>
                  <th className="th text-left">Yarn</th>
                  <th className="th text-right">Planned PCS</th>
                  <th className="th text-right">Planned KG</th>
                  <th className="th text-right">Produced PCS</th>
                  <th className="th text-right">Actual KG</th>
                  <th className="th text-center">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="td font-mono font-semibold text-brand-700">{r.program_no}</td>
                    <td className="td text-slate-500">{fmtDate(r.program_date)}</td>
                    <td className="td">{r.style_code ?? '—'}</td>
                    <td className="td">{r.yarn_code ?? '—'}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(r.expected_pcs)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.planned_yarn_kg, 3)}</td>
                    <td className="td text-right tabular-nums font-semibold text-emerald-700">
                      {fmtNumber(r.produced_pcs)}
                    </td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.actual_yarn_kg, 3)}</td>
                    <td className="td text-center">
                      <Badge tone={STATUS_TONE[r.status] ?? 'slate'}>{r.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="td text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn-icon" title="View" onClick={() => setDetailId(r.id)}>
                          <Eye size={14} />
                        </button>
                        {['DRAFT', 'STOCK_CHECK'].includes(r.status) && (
                          <button className="btn-icon" title="Check stock"
                            onClick={() => void act(r.id, 'check-stock', 'Stock checked')}>
                            <Boxes size={14} />
                          </button>
                        )}
                        {['DRAFT', 'STOCK_CHECK'].includes(r.status) && (
                          <button className="btn-icon" title="Reserve yarn"
                            onClick={() => void act(r.id, 'reserve', 'Yarn reserved')}>
                            <ShieldCheck size={14} />
                          </button>
                        )}
                        {['RESERVED', 'STOCK_CHECK', 'DRAFT'].includes(r.status) && (
                          <button className="btn-icon" title="Release"
                            onClick={() => void act(r.id, 'release', 'Program released')}>
                            <PackageCheck size={14} />
                          </button>
                        )}
                        <button className="btn-icon" title="Record production"
                          onClick={() => setProdFor(r)}>
                          <Factory size={14} />
                        </button>
                        <button className="btn-icon" title="Receive collars into stock (PCS)"
                          onClick={() => setRcptFor(r)}>
                          <Warehouse size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && (
            <Pager page={pagination.page} totalPages={pagination.totalPages}
              total={pagination.total} pageSize={pagination.pageSize} onPage={setPage} />
          )}
        </>
      )}

      {/* ── Create program ─────────────────────────────── */}
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title="New Collar Knitting Program"
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setOpen(false)}><X size={14} /> Cancel</button>
            <button className="btn-primary" disabled={saving} onClick={() => void save()} id="btn-save-collar">
              <Save size={14} /> {saving ? 'Saving…' : 'Create Program'}
            </button>
          </div>
        }>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input label="Program Date" type="date" value={form.program_date}
              onChange={(e) => setF('program_date', e.target.value)} id="c-date" />
            <Select label="Sales Order line" value={form.so_line_id} placeholder="— Not linked —"
              onChange={(e) => onSoLine(e.target.value)} id="c-soline">
              {soLines.map((l: any) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
            <Input label="I/O Number" value={form.io_no}
              onChange={(e) => setF('io_no', e.target.value)} id="c-io" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Select label="Collar (BOM)" value={form.collar_id} placeholder="— Select collar —"
              onChange={(e) => onCollarSelect(e.target.value)} id="c-collar">
              {collars.map((c: any) => (
                <option key={c.id} value={c.id}>{c.collar_code} — {c.collar_type} ({c.std_weight_gm} gm)</option>
              ))}
            </Select>
            <Input label="Collar Type" value={form.collar_type}
              onChange={(e) => setF('collar_type', e.target.value)} id="c-type" />
            <Input label="Colour" value={form.colour}
              onChange={(e) => setF('colour', e.target.value)} id="c-colour" />
            <Select label="Yarn" required value={form.yarn_id} placeholder="— Select yarn —"
              onChange={(e) => setF('yarn_id', e.target.value ? Number(e.target.value) : '')} id="c-yarn">
              {yarns.map((y: any) => <option key={y.id} value={y.id}>{y.code} — {y.label}</option>)}
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Select label="Style" value={form.style_id} placeholder="— Select style —"
              onChange={(e) => setF('style_id', e.target.value ? Number(e.target.value) : '')} id="c-style">
              {styles.map((s: any) => <option key={s.id} value={s.id}>{s.code} — {s.label}</option>)}
            </Select>
            <Input label="Gauge / Needle" value={form.gauge_needle}
              onChange={(e) => setF('gauge_needle', e.target.value)} id="c-gauge" />
            <Input label="Required Date" type="date" value={form.required_date}
              onChange={(e) => setF('required_date', e.target.value)} id="c-reqdate" />
            <Select label="Unit" value={form.job_work_type}
              onChange={(e) => setF('job_work_type', e.target.value)} id="c-jobwork">
              <option value="INTERNAL">Internal</option>
              <option value="JOB_WORK">Job Work</option>
            </Select>
          </div>

          {form.job_work_type === 'JOB_WORK' && (
            <Select label="Vendor" required value={form.vendor_id} placeholder="— Select vendor —"
              onChange={(e) => setF('vendor_id', e.target.value ? Number(e.target.value) : '')} id="c-vendor">
              {parties.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          )}

          {/* Size-wise planning grid */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Size-wise Planning (PCS → KG)
              </h4>
              <button className="btn-secondary btn-sm"
                onClick={() => setForm((s) => ({ ...s, sizes: [...s.sizes, newSize()] }))} id="btn-add-size">
                <Plus size={13} /> Add Size
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-[12px]">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th text-left">Size</th>
                    <th className="th w-32">Std Weight (gm/pc)</th>
                    <th className="th w-32">Planned PCS</th>
                    <th className="th w-32 text-right">Std Yarn (KG)</th>
                    <th className="th w-12" />
                  </tr>
                </thead>
                <tbody>
                  {form.sizes.map((z, i) => {
                    const kg = ((Number(z.planned_pcs) || 0) * (Number(z.std_weight_gm) || 0)) / 1000;
                    return (
                      <tr key={z._key} className="border-t border-slate-100">
                        <td className="td p-1">
                          <select className="input text-[12px]" value={z.size_id}
                            onChange={(e) => {
                              const sz = sizes.find((x: any) => x.id === Number(e.target.value));
                              setSize(z._key, {
                                size_id: e.target.value ? Number(e.target.value) : '',
                                size_code: sz?.size_code ?? sz?.code ?? '',
                              });
                            }} id={`sz-${i}`}>
                            <option value="">— Select size —</option>
                            {sizes.map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </td>
                        <td className="td p-1">
                          <input className="input text-[12px]" type="number" step="0.001" min="0"
                            value={z.std_weight_gm} placeholder="25"
                            onChange={(e) => setSize(z._key, {
                              std_weight_gm: e.target.value === '' ? '' : Number(e.target.value),
                            })} id={`sz-wt-${i}`} />
                        </td>
                        <td className="td p-1">
                          <input className="input text-[12px]" type="number" min="0"
                            value={z.planned_pcs} placeholder="0"
                            onChange={(e) => setSize(z._key, {
                              planned_pcs: e.target.value === '' ? '' : Number(e.target.value),
                            })} id={`sz-pcs-${i}`} />
                        </td>
                        <td className="td text-right tabular-nums font-semibold text-brand-700">
                          {fmtDecimal(kg, 3)}
                        </td>
                        <td className="td text-center">
                          <button className="btn-icon text-rose-600"
                            onClick={() => setForm((s) => ({
                              ...s, sizes: s.sizes.filter((x) => x._key !== z._key),
                            }))}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50">
                  <tr>
                    <td className="td font-bold text-slate-700">Total</td>
                    <td />
                    <td className="td text-right font-bold tabular-nums">{fmtNumber(totals.pcs)} pcs</td>
                    <td className="td text-right font-bold tabular-nums text-brand-700">
                      {fmtDecimal(totals.kg, 3)} KG
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">
              These are planning figures. Actual consumption is recorded per production entry,
              and the actual weight per piece is derived from actual KG ÷ actual PCS.
            </p>
          </div>

          <Textarea label="Remarks" value={form.remarks}
            onChange={(e) => setF('remarks', e.target.value)} id="c-remarks" />
        </div>
      </Modal>

      {/* ── Production entry ───────────────────────────── */}
      <ProductionModal program={prodFor} onClose={() => setProdFor(null)}
        sizes={sizes}
        onSaved={() => {
          setProdFor(null);
          void qc.invalidateQueries({ queryKey: ['collar-programs'] });
          void qc.invalidateQueries({ queryKey: ['collar-program'] });
        }} />

      <ReceiptModal program={rcptFor} sizes={sizes} warehouses={warehouses}
        onClose={() => setRcptFor(null)}
        onSaved={() => {
          setRcptFor(null);
          void qc.invalidateQueries({ queryKey: ['collar-programs'] });
          void qc.invalidateQueries({ queryKey: ['collar-program'] });
        }} />

      {/* ── Detail ─────────────────────────────────────── */}
      <Modal open={detailId != null} onClose={() => setDetailId(null)} size="lg"
        title={detail ? `${detail.program_no} — Collar Program` : 'Collar Program'}>
        {!detail ? <LoadingBlock label="Loading…" /> : (
          <div className="space-y-4 text-[12px]">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Info label="Status" value={<Badge tone={STATUS_TONE[detail.status] ?? 'slate'}>{detail.status.replace(/_/g, ' ')}</Badge>} />
              <Info label="Style" value={detail.style_code ?? '—'} />
              <Info label="Yarn" value={detail.yarn_code ?? '—'} />
              <Info label="Part" value={detail.part_name ?? '—'} />
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 sm:grid-cols-4">
              <Info label="Planned PCS" value={fmtNumber(detail.summary?.expected_pcs)} />
              <Info label="Planned KG" value={fmtDecimal(detail.summary?.planned_yarn_kg, 3)} />
              <Info label="Produced PCS" value={fmtNumber(detail.summary?.produced_pcs)} />
              <Info label="Actual KG" value={fmtDecimal(detail.summary?.actual_yarn_kg, 3)} />
              <Info label="Good PCS" value={fmtNumber(detail.summary?.good_pcs)} />
              <Info label="Actual gm/pc"
                value={<span className="font-bold text-indigo-800">
                  {detail.summary?.actual_wt_gm_pc != null ? fmtDecimal(detail.summary.actual_wt_gm_pc, 3) : '—'}
                </span>} />
              <Info label="Yarn variance KG"
                value={<span className={Number(detail.summary?.yarn_variance_kg) > 0 ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                  {fmtDecimal(detail.summary?.yarn_variance_kg, 3)}
                </span>} />
              <Info label="PCS variance" value={fmtNumber(detail.summary?.pcs_variance)} />
              <Info label="Received PCS" value={fmtNumber(detail.summary?.received_pcs)} />
              <Info label="In stock PCS"
                value={<span className="font-bold text-emerald-800">
                  {fmtNumber(detail.summary?.in_stock_pcs)}
                </span>} />
            </div>

            <Section title={`Size-wise plan (${detail.sizes?.length ?? 0})`}>
              <SimpleTable head={['Size', 'Std gm/pc', 'Planned PCS', 'Std Yarn KG', 'Produced PCS']}
                rows={(detail.sizes ?? []).map((z: any) => [
                  z.size_code ?? z.size_master_code ?? '—',
                  fmtDecimal(z.std_weight_gm, 3), fmtNumber(z.planned_pcs),
                  fmtDecimal(z.std_yarn_kg, 3), fmtNumber(z.produced_pcs),
                ])} />
            </Section>

            <Section title={`Production entries (${detail.productions?.length ?? 0})`}>
              {(detail.productions ?? []).length === 0 ? <Muted>No production recorded</Muted> : (
                <SimpleTable head={['Entry', 'Date', 'Size', 'Produced', 'Rejected', 'Good', 'Actual KG', 'Actual gm/pc']}
                  rows={(detail.productions ?? []).map((p: any) => [
                    p.entry_no, fmtDate(p.production_date), p.size_code ?? '—',
                    fmtNumber(p.produced_pcs), fmtNumber(p.rejected_pcs), fmtNumber(p.good_pcs),
                    fmtDecimal(p.actual_yarn_kg, 3),
                    <span className="font-semibold text-indigo-700">{fmtDecimal(p.actual_wt_gm_pc, 3)}</span>,
                  ])} />
              )}
            </Section>

            <Section title={`Stock receipts (${detail.receipts?.length ?? 0})`}>
              {(detail.receipts ?? []).length === 0 ? <Muted>No collars received into stock yet</Muted> : (
                <SimpleTable head={['Receipt', 'Date', 'Size', 'Received', 'Rejected', 'Good PCS', 'Yarn KG ref', 'QC', 'Posted']}
                  rows={(detail.receipts ?? []).map((r: any) => [
                    r.receipt_no, fmtDate(r.receipt_date),
                    r.size_code ?? r.size_master_code ?? '—',
                    fmtNumber(r.received_pcs), fmtNumber(r.rejected_pcs),
                    <span className="font-semibold text-emerald-700">{fmtNumber(r.good_pcs)}</span>,
                    fmtDecimal(r.yarn_kg_ref, 3),
                    <Badge tone={r.qc_status === 'PASSED' ? 'emerald' : 'amber'}>{r.qc_status}</Badge>,
                    r.is_stock_posted ? 'Yes' : 'No',
                  ])} />
              )}
            </Section>

            <Section title={`Yarn issues (${detail.issues?.length ?? 0})`}>
              {(detail.issues ?? []).length === 0 ? <Muted>No yarn issued yet</Muted> : (
                <SimpleTable head={['Issue No', 'Date', 'Lot', 'Yarn PO', 'KG']}
                  rows={(detail.issues ?? []).map((i: any) => [
                    i.issue_no, fmtDate(i.issue_date), i.lot_no ?? '—',
                    i.yarn_po_no ?? '—', fmtDecimal(i.issued_qty_kg, 3),
                  ])} />
              )}
            </Section>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ProductionModal({ program, sizes, onClose, onSaved }: {
  program: any | null; sizes: any[]; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    production_date: today(), size_id: '' as number | '', shift: '',
    planned_pcs: '' as number | '', produced_pcs: '' as number | '',
    rejected_pcs: '' as number | '', actual_yarn_kg: '' as number | '', remarks: '',
  });
  const [saving, setSaving] = useState(false);

  const good = (Number(f.produced_pcs) || 0) - (Number(f.rejected_pcs) || 0);
  const actualGm = Number(f.produced_pcs) > 0
    ? ((Number(f.actual_yarn_kg) || 0) * 1000) / Number(f.produced_pcs) : null;

  const save = async () => {
    if (!program) return;
    if ((Number(f.rejected_pcs) || 0) > (Number(f.produced_pcs) || 0)) {
      toast('Rejected pieces cannot exceed produced pieces', 'error'); return;
    }
    setSaving(true);
    try {
      await http.post('/collar-productions', {
        program_id: program.id, production_date: f.production_date,
        size_id: f.size_id === '' ? null : Number(f.size_id),
        shift: f.shift || null,
        planned_pcs: Number(f.planned_pcs) || 0,
        produced_pcs: Number(f.produced_pcs) || 0,
        rejected_pcs: Number(f.rejected_pcs) || 0,
        actual_yarn_kg: Number(f.actual_yarn_kg) || 0,
        remarks: f.remarks || null,
      });
      toast('Production recorded');
      setF({ production_date: today(), size_id: '', shift: '', planned_pcs: '',
             produced_pcs: '', rejected_pcs: '', actual_yarn_kg: '', remarks: '' });
      onSaved();
    } catch (e: any) {
      toast(e?.message || 'Could not record production', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={program != null} onClose={onClose} size="md"
      title={program ? `Production — ${program.program_no}` : 'Production'}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={() => void save()} id="btn-save-collar-prod">
            <Save size={14} /> {saving ? 'Saving…' : 'Record Production'}
          </button>
        </div>
      }>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Production Date" type="date" value={f.production_date}
            onChange={(e) => setF((s) => ({ ...s, production_date: e.target.value }))} id="cp-date" />
          <Select label="Size" value={f.size_id} placeholder="— Any —"
            onChange={(e) => setF((s) => ({ ...s, size_id: e.target.value ? Number(e.target.value) : '' }))}
            id="cp-size">
            {sizes.map((z: any) => <option key={z.id} value={z.id}>{z.label}</option>)}
          </Select>
          <Input label="Shift" value={f.shift}
            onChange={(e) => setF((s) => ({ ...s, shift: e.target.value }))} id="cp-shift" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input label="Planned PCS" type="number" value={f.planned_pcs}
            onChange={(e) => setF((s) => ({ ...s, planned_pcs: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cp-planned" />
          <Input label="Produced PCS" type="number" value={f.produced_pcs}
            onChange={(e) => setF((s) => ({ ...s, produced_pcs: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cp-produced" />
          <Input label="Rejected PCS" type="number" value={f.rejected_pcs}
            onChange={(e) => setF((s) => ({ ...s, rejected_pcs: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cp-rejected" />
          <Input label="Actual Yarn (KG)" type="number" step="0.001" value={f.actual_yarn_kg}
            onChange={(e) => setF((s) => ({ ...s, actual_yarn_kg: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cp-yarn" />
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3">
          <Info label="Good PCS" value={<span className="font-bold">{fmtNumber(good)}</span>} />
          <Info label="Actual weight (derived)"
            value={<span className="font-bold text-indigo-800">
              {actualGm != null ? `${fmtDecimal(actualGm, 3)} gm/pc` : '—'}
            </span>} />
        </div>

        <Textarea label="Remarks" value={f.remarks}
          onChange={(e) => setF((s) => ({ ...s, remarks: e.target.value }))} id="cp-remarks" />
      </div>
    </Modal>
  );
}

/**
 * Collar receipt — puts finished collars into stock as PIECES (doc §16.5).
 * The yarn KG is captured only as a costing reference alongside them.
 */
function ReceiptModal({ program, sizes, warehouses, onClose, onSaved }: {
  program: any | null; sizes: any[]; warehouses: any[];
  onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState({
    receipt_date: today(), size_id: '' as number | '', size_code: '',
    received_pcs: '' as number | '', rejected_pcs: '' as number | '',
    yarn_kg_ref: '' as number | '', warehouse_id: '' as number | '',
    qc_status: 'PENDING', post_stock: false, remarks: '',
  });
  const [saving, setSaving] = useState(false);

  const good = (Number(f.received_pcs) || 0) - (Number(f.rejected_pcs) || 0);
  const gmPerPc = good > 0 ? ((Number(f.yarn_kg_ref) || 0) * 1000) / good : null;

  const save = async () => {
    if (!program) return;
    if (!f.warehouse_id) { toast('Select a warehouse', 'error'); return; }
    if (f.post_stock && f.qc_status !== 'PASSED') {
      toast('Collars can only be posted to stock once QC has passed', 'error'); return;
    }
    setSaving(true);
    try {
      await http.post('/collar-receipts', {
        program_id: program.id, receipt_date: f.receipt_date,
        size_id: f.size_id === '' ? null : Number(f.size_id),
        size_code: f.size_code || null,
        received_pcs: Number(f.received_pcs) || 0,
        rejected_pcs: Number(f.rejected_pcs) || 0,
        yarn_kg_ref: Number(f.yarn_kg_ref) || 0,
        warehouse_id: Number(f.warehouse_id),
        qc_status: f.qc_status, post_stock: f.post_stock,
        remarks: f.remarks || null,
      });
      toast(f.post_stock ? `${good} collars posted to stock` : 'Receipt recorded');
      setF({ receipt_date: today(), size_id: '', size_code: '', received_pcs: '',
             rejected_pcs: '', yarn_kg_ref: '', warehouse_id: '', qc_status: 'PENDING',
             post_stock: false, remarks: '' });
      onSaved();
    } catch (e: any) {
      toast(e?.message || 'Could not record the receipt', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={program != null} onClose={onClose} size="md"
      title={program ? `Receive Collars — ${program.program_no}` : 'Receive Collars'}
      footer={
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
          <button className="btn-primary" disabled={saving} onClick={() => void save()} id="btn-save-collar-rcpt">
            <Save size={14} /> {saving ? 'Saving…' : 'Record Receipt'}
          </button>
        </div>
      }>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Receipt Date" type="date" value={f.receipt_date}
            onChange={(e) => setF((s) => ({ ...s, receipt_date: e.target.value }))} id="cr-date" />
          <Select label="Size" value={f.size_id} placeholder="— Any —"
            onChange={(e) => {
              const sz = sizes.find((x: any) => x.id === Number(e.target.value));
              setF((s) => ({ ...s, size_id: e.target.value ? Number(e.target.value) : '',
                             size_code: sz?.size_code ?? sz?.code ?? '' }));
            }} id="cr-size">
            {sizes.map((z: any) => <option key={z.id} value={z.id}>{z.label}</option>)}
          </Select>
          <Select label="Warehouse" required value={f.warehouse_id} placeholder="— Select —"
            onChange={(e) => setF((s) => ({ ...s, warehouse_id: e.target.value ? Number(e.target.value) : '' }))}
            id="cr-wh">
            {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Received PCS" type="number" value={f.received_pcs}
            onChange={(e) => setF((s) => ({ ...s, received_pcs: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cr-received" />
          <Input label="Rejected PCS" type="number" value={f.rejected_pcs}
            onChange={(e) => setF((s) => ({ ...s, rejected_pcs: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cr-rejected" />
          <Input label="Yarn KG (reference)" type="number" step="0.001" value={f.yarn_kg_ref}
            hint="Costing reference only — stock is counted in pieces"
            onChange={(e) => setF((s) => ({ ...s, yarn_kg_ref: e.target.value === '' ? '' : Number(e.target.value) }))}
            id="cr-yarnkg" />
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
          <Info label="Good PCS into stock"
            value={<span className="font-bold text-emerald-800">{fmtNumber(good)}</span>} />
          <Info label="Implied weight"
            value={gmPerPc != null ? `${fmtDecimal(gmPerPc, 3)} gm/pc` : '—'} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="QC Status" value={f.qc_status}
            onChange={(e) => setF((s) => ({ ...s, qc_status: e.target.value }))} id="cr-qc">
            {['PENDING', 'PASSED', 'HOLD', 'REJECTED'].map((q) => <option key={q} value={q}>{q}</option>)}
          </Select>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[12px] text-slate-700">
              <input type="checkbox" checked={f.post_stock}
                disabled={f.qc_status !== 'PASSED'}
                onChange={(e) => setF((s) => ({ ...s, post_stock: e.target.checked }))}
                id="cr-post" />
              Post to stock now
              {f.qc_status !== 'PASSED' && (
                <span className="text-[10px] text-slate-400">(needs QC passed)</span>
              )}
            </label>
          </div>
        </div>

        <Textarea label="Remarks" value={f.remarks}
          onChange={(e) => setF((s) => ({ ...s, remarks: e.target.value }))} id="cr-remarks" />
      </div>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-[12px] text-slate-800">{value}</p>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">{title}</h4>
      {children}
    </div>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-center text-[12px] text-slate-400">{children}</p>;
}
function SimpleTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded border border-slate-200">
      <table className="w-full text-[11px]">
        <thead className="bg-slate-50">
          <tr>{head.map((h) => <th key={h} className="th text-left">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              {r.map((c, j) => <td key={j} className="td">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
