import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Save, X, Eye, Trash2, Beaker, PackageCheck, ShieldCheck, Boxes,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import {
  Modal, PageHeader, Input, Select, Textarea, LoadingBlock, EmptyState,
  SearchInput, Badge, Pager,
} from '../../components/ui';

/**
 * Yarn Dyeing (doc §7), Winding (doc §8) and Twisting (doc §9).
 *
 * One page serves the three processes because they share the same lifecycle;
 * the process-specific attribute block switches on the selected type, which is
 * what the document means by a common architecture with separate screens.
 */

type ProcType = 'YARN_DYEING' | 'WINDING' | 'TWISTING';

const PROC_LABEL: Record<ProcType, string> = {
  YARN_DYEING: 'Yarn Dyeing',
  WINDING: 'Winding',
  TWISTING: 'Twisting',
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', STOCK_CHECK: 'sky', RESERVED: 'indigo', RELEASED: 'violet',
  MATERIAL_ISSUED: 'amber', IN_PROGRESS: 'amber', PRODUCTION_COMPLETED: 'emerald',
  OUTPUT_RECEIPT: 'emerald', QC: 'sky', STOCK_POSTED: 'emerald',
  COMPLETED: 'emerald', CANCELLED: 'rose',
};

const STATUSES = [
  'DRAFT', 'STOCK_CHECK', 'RESERVED', 'RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS',
  'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED', 'COMPLETED', 'CANCELLED',
] as const;

const emptyForm = {
  process_date: today(), process_type: 'YARN_DYEING' as ProcType,
  route_id: '' as number | '', so_line_id: '' as number | '',
  io_no: '', buyer_po_no: '', style_id: '' as number | '', part_name: '',
  yarn_id: '' as number | '', input_qty_kg: '' as number | '',
  expected_loss_pct: '' as number | '', required_date: '',
  priority: 'NORMAL', job_work_type: 'INTERNAL', vendor_id: '' as number | '',
  warehouse_id: '' as number | '', status: 'DRAFT', remarks: '',
  // process-specific
  colour_name: '', shade_code: '', batch_no: '', temperature: '', duration_min: '' as number | '', liquor_ratio: '',
  cone_type: '', target_cone_wt_kg: '' as number | '', speed_rpm: '', operator: '', shift: '',
  twist_type: 'Z', ply: '' as number | '', target_count: '', tpi: '' as number | '', spindle_speed: '',
};

export default function YarnProcessPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [typeFilter, setTypeFilter] = useState<ProcType | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const lk = (name: string) => useQuery({
    queryKey: ['lookups', name],
    queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${name}`)).data || [],
  });
  const { data: yarns = [] } = lk('yarns');
  const { data: parties = [] } = lk('parties');
  const { data: warehouses = [] } = lk('warehouses');
  const { data: soLines = [] } = lk('sales-order-lines');
  const { data: routes = [] } = useQuery({
    queryKey: ['process-routes-lookup'],
    queryFn: async () => (await http.get<{ data: any[] }>('/process-routes')).data || [],
  });

  const { data: listRes, isLoading, refetch } = useQuery({
    queryKey: ['yarn-processes', typeFilter, statusFilter, search, page],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (typeFilter !== 'ALL') p.set('process_type', typeFilter);
      if (statusFilter !== 'ALL') p.set('status', statusFilter);
      if (search) p.set('q', search);
      return await http.get<{ data: any[]; pagination: any }>(`/yarn-processes?${p}`);
    },
  });
  const rows = listRes?.data ?? [];
  const pagination = listRes?.pagination;

  const { data: detail } = useQuery({
    queryKey: ['yarn-process', detailId],
    queryFn: async () => (await http.get<{ data: any }>(`/yarn-processes/${detailId}`)).data,
    enabled: detailId != null,
  });

  const setF = (k: string, v: any) => setForm((s) => ({ ...s, [k]: v }));

  // Expected output after planning loss, shown live so the planner sees it.
  const expectedOut = (() => {
    const inp = Number(form.input_qty_kg) || 0;
    const loss = Number(form.expected_loss_pct) || 0;
    return Math.round(inp * (1 - loss / 100) * 1000) / 1000;
  })();

  const targetCones = (() => {
    const w = Number(form.target_cone_wt_kg) || 0;
    const inp = Number(form.input_qty_kg) || 0;
    return w > 0 ? Math.floor(inp / w) : null;
  })();

  const onSoLine = (value: string) => {
    const l = soLines.find((x: any) => x.id === Number(value));
    setForm((s) => ({
      ...s,
      so_line_id: value === '' ? '' : Number(value),
      style_id: l?.style_id ?? s.style_id,
      part_name: l?.part_name ?? s.part_name,
    }));
  };
  // When the process is linked to a Sales Order line, that line owns the part;
  // the server enforces the same rule, so show it read-only here.
  const linkedPart: string | null = form.so_line_id === '' ? null
    : (soLines.find((l: any) => l.id === Number(form.so_line_id))?.part_name ?? null);

  const save = async () => {
    if (!form.yarn_id) { toast('Select a yarn', 'error'); return; }
    if (!form.warehouse_id) { toast('Select a warehouse', 'error'); return; }

    const base: any = {
      process_date: form.process_date, process_type: form.process_type,
      route_id: form.route_id === '' ? null : Number(form.route_id),
      so_line_id: form.so_line_id === '' ? null : Number(form.so_line_id),
      io_no: form.io_no || null, buyer_po_no: form.buyer_po_no || null,
      style_id: form.style_id === '' ? null : Number(form.style_id),
      part_name: form.part_name || null,
      yarn_id: Number(form.yarn_id),
      input_qty_kg: Number(form.input_qty_kg) || 0,
      expected_loss_pct: Number(form.expected_loss_pct) || 0,
      required_date: form.required_date || null,
      priority: form.priority, job_work_type: form.job_work_type,
      vendor_id: form.vendor_id === '' ? null : Number(form.vendor_id),
      warehouse_id: Number(form.warehouse_id),
      status: form.status, remarks: form.remarks || null,
    };
    if (form.process_type === 'YARN_DYEING') {
      base.dyeing = {
        colour_name: form.colour_name || null, shade_code: form.shade_code || null,
        batch_no: form.batch_no || null, temperature: form.temperature || null,
        duration_min: form.duration_min === '' ? null : Number(form.duration_min),
        liquor_ratio: form.liquor_ratio || null,
      };
    } else if (form.process_type === 'WINDING') {
      base.winding = {
        cone_type: form.cone_type || null,
        target_cone_wt_kg: form.target_cone_wt_kg === '' ? null : Number(form.target_cone_wt_kg),
        speed_rpm: form.speed_rpm || null, operator: form.operator || null, shift: form.shift || null,
      };
    } else {
      base.twisting = {
        twist_type: form.twist_type || null,
        ply: form.ply === '' ? null : Number(form.ply),
        target_count: form.target_count || null,
        tpi: form.tpi === '' ? null : Number(form.tpi),
        spindle_speed: form.spindle_speed || null,
        operator: form.operator || null, shift: form.shift || null,
      };
    }

    setSaving(true);
    try {
      await http.post('/yarn-processes', base);
      toast('Process created');
      setOpen(false);
      setForm({ ...emptyForm });
      void qc.invalidateQueries({ queryKey: ['yarn-processes'] });
    } catch (e: any) {
      toast(e?.message || 'Could not create the process', 'error');
    } finally { setSaving(false); }
  };

  const act = async (id: number, action: string, label: string) => {
    try {
      const r = await http.post<{ data: any }>(`/yarn-processes/${id}/${action}`, {});
      if (action === 'check-stock') {
        const rows = (r as any).data ?? [];
        const short = rows.filter((x: any) => Number(x.shortage_kg) > 0);
        toast(
          short.length ? `Shortage: ${short.map((x: any) => `${x.shortage_kg} KG`).join(', ')}`
                       : 'Stock is sufficient',
          short.length ? 'error' : 'success');
      } else toast(label);
      void qc.invalidateQueries({ queryKey: ['yarn-processes'] });
      void qc.invalidateQueries({ queryKey: ['yarn-process'] });
    } catch (e: any) { toast(e?.message || `Could not ${label.toLowerCase()}`, 'error'); }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this process?')) return;
    try {
      await http.del(`/yarn-processes/${id}`);
      toast('Process deleted');
      void qc.invalidateQueries({ queryKey: ['yarn-processes'] });
    } catch (e: any) { toast(e?.message || 'Could not delete', 'error'); }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Yarn Processing"
        subtitle="Dyeing, winding and twisting — plan, reserve, issue, receive and QC"
        actions={
          <button className="btn-primary" onClick={() => { setForm({ ...emptyForm }); setOpen(true); }}
            id="btn-new-process">
            <Plus size={15} /> New Process
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-44" value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as any); setPage(1); }} id="f-type">
          <option value="ALL">All processes</option>
          {(Object.keys(PROC_LABEL) as ProcType[]).map((p) => (
            <option key={p} value={p}>{PROC_LABEL[p]}</option>
          ))}
        </select>
        <select className="input w-44" value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} id="f-status">
          <option value="ALL">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }}
          placeholder="Search process no, I/O, buyer PO…" />
        <button className="btn-secondary" onClick={() => void refetch()}>Refresh</button>
      </div>

      {isLoading ? <LoadingBlock label="Loading processes…" /> : rows.length === 0 ? (
        <EmptyState icon={<Beaker size={22} />} title="No processes yet"
          message="Create a dyeing, winding or twisting process to begin." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th text-left">Process No</th>
                  <th className="th text-left">Type</th>
                  <th className="th text-left">Date</th>
                  <th className="th text-left">Yarn</th>
                  <th className="th text-right">Input KG</th>
                  <th className="th text-right">Expected</th>
                  <th className="th text-right">Issued</th>
                  <th className="th text-right">Received</th>
                  <th className="th text-center">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                    <td className="td font-mono font-semibold text-brand-700">{r.process_no}</td>
                    <td className="td">{PROC_LABEL[r.process_type as ProcType] ?? r.process_type}</td>
                    <td className="td text-slate-500">{fmtDate(r.process_date)}</td>
                    <td className="td">{r.yarn_code ? `${r.yarn_code} — ${r.yarn_name}` : '—'}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.input_qty_kg, 3)}</td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtDecimal(r.expected_output, 3)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.issued_kg, 3)}</td>
                    <td className="td text-right tabular-nums font-semibold text-emerald-700">
                      {fmtDecimal(r.received_qty, 3)}
                    </td>
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
                            onClick={() => void act(r.id, 'release', 'Process released')}>
                            <PackageCheck size={14} />
                          </button>
                        )}
                        {['DRAFT', 'CANCELLED'].includes(r.status) && (
                          <button className="btn-icon text-rose-600" title="Delete"
                            onClick={() => void remove(r.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
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

      {/* ── Create ─────────────────────────────────────────── */}
      <Modal open={open} onClose={() => setOpen(false)} size="lg"
        title={`New ${PROC_LABEL[form.process_type]} Process`}
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setOpen(false)}><X size={14} /> Cancel</button>
            <button className="btn-primary" disabled={saving} onClick={() => void save()} id="btn-save-process">
              <Save size={14} /> {saving ? 'Saving…' : 'Create Process'}
            </button>
          </div>
        }>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Process Type" value={form.process_type}
              onChange={(e) => setF('process_type', e.target.value)} id="p-type">
              {(Object.keys(PROC_LABEL) as ProcType[]).map((p) => (
                <option key={p} value={p}>{PROC_LABEL[p]}</option>
              ))}
            </Select>
            <Input label="Process Date" type="date" value={form.process_date}
              onChange={(e) => setF('process_date', e.target.value)} id="p-date" />
            <Select label="Process Route" value={form.route_id} placeholder="— None —"
              onChange={(e) => setF('route_id', e.target.value ? Number(e.target.value) : '')} id="p-route">
              {routes.map((r: any) => <option key={r.id} value={r.id}>{r.route_code} — {r.route_name}</option>)}
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Sales Order line" value={form.so_line_id} placeholder="— Not linked —"
              onChange={(e) => onSoLine(e.target.value)} id="p-soline">
              {soLines.map((l: any) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
            <Input label="I/O Number" value={form.io_no}
              onChange={(e) => setF('io_no', e.target.value)} id="p-io" />
            <Input label="Part" value={linkedPart ?? form.part_name}
              readOnly={linkedPart !== null}
              hint={linkedPart ? 'Follows the linked Sales Order line' : undefined}
              onChange={(e) => setF('part_name', e.target.value)} id="p-part" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="Yarn" required value={form.yarn_id} placeholder="— Select yarn —"
              onChange={(e) => setF('yarn_id', e.target.value ? Number(e.target.value) : '')} id="p-yarn">
              {yarns.map((y: any) => <option key={y.id} value={y.id}>{y.code} — {y.label}</option>)}
            </Select>
            <Input label="Input Qty (KG)" type="number" step="0.001" value={form.input_qty_kg}
              onChange={(e) => setF('input_qty_kg', e.target.value === '' ? '' : Number(e.target.value))}
              id="p-input" />
            <Input label="Planning Loss %" type="number" step="0.001" value={form.expected_loss_pct}
              hint={`Expected output: ${fmtDecimal(expectedOut, 3)} KG`}
              onChange={(e) => setF('expected_loss_pct', e.target.value === '' ? '' : Number(e.target.value))}
              id="p-loss" />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Input label="Required Date" type="date" value={form.required_date}
              onChange={(e) => setF('required_date', e.target.value)} id="p-reqdate" />
            <Select label="Priority" value={form.priority}
              onChange={(e) => setF('priority', e.target.value)} id="p-priority">
              {['NORMAL', 'URGENT', 'HOLD'].map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Select label="Unit" value={form.job_work_type}
              onChange={(e) => setF('job_work_type', e.target.value)} id="p-jobwork">
              <option value="INTERNAL">Internal</option>
              <option value="JOB_WORK">Job Work</option>
            </Select>
            <Select label="Warehouse" required value={form.warehouse_id} placeholder="— Select —"
              onChange={(e) => setF('warehouse_id', e.target.value ? Number(e.target.value) : '')} id="p-wh">
              {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
          </div>

          {form.job_work_type === 'JOB_WORK' && (
            <Select label="Vendor" required value={form.vendor_id} placeholder="— Select vendor —"
              onChange={(e) => setF('vendor_id', e.target.value ? Number(e.target.value) : '')} id="p-vendor">
              {parties.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          )}

          {/* Process-specific attributes */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              {PROC_LABEL[form.process_type]} details
            </h4>

            {form.process_type === 'YARN_DYEING' && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Input label="Colour" value={form.colour_name}
                  onChange={(e) => setF('colour_name', e.target.value)} id="d-colour" />
                <Input label="Shade Code" value={form.shade_code}
                  onChange={(e) => setF('shade_code', e.target.value)} id="d-shade" />
                <Input label="Batch No" value={form.batch_no}
                  onChange={(e) => setF('batch_no', e.target.value)} id="d-batch" />
                <Input label="Temperature" value={form.temperature}
                  onChange={(e) => setF('temperature', e.target.value)} id="d-temp" />
                <Input label="Duration (min)" type="number" value={form.duration_min}
                  onChange={(e) => setF('duration_min', e.target.value === '' ? '' : Number(e.target.value))}
                  id="d-dur" />
                <Input label="Liquor Ratio" value={form.liquor_ratio} placeholder="e.g. 1:8"
                  onChange={(e) => setF('liquor_ratio', e.target.value)} id="d-liquor" />
              </div>
            )}

            {form.process_type === 'WINDING' && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Input label="Cone Type" value={form.cone_type}
                  onChange={(e) => setF('cone_type', e.target.value)} id="w-cone" />
                <Input label="Target Cone Weight (KG)" type="number" step="0.001"
                  value={form.target_cone_wt_kg}
                  hint={targetCones != null ? `≈ ${targetCones} cones` : undefined}
                  onChange={(e) => setF('target_cone_wt_kg', e.target.value === '' ? '' : Number(e.target.value))}
                  id="w-conewt" />
                <Input label="Speed / RPM" value={form.speed_rpm}
                  onChange={(e) => setF('speed_rpm', e.target.value)} id="w-rpm" />
                <Input label="Operator" value={form.operator}
                  onChange={(e) => setF('operator', e.target.value)} id="w-op" />
                <Input label="Shift" value={form.shift}
                  onChange={(e) => setF('shift', e.target.value)} id="w-shift" />
              </div>
            )}

            {form.process_type === 'TWISTING' && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Select label="Twist Direction" value={form.twist_type}
                  onChange={(e) => setF('twist_type', e.target.value)} id="t-twist">
                  <option value="S">S</option>
                  <option value="Z">Z</option>
                </Select>
                <Input label="Ply" type="number" value={form.ply}
                  onChange={(e) => setF('ply', e.target.value === '' ? '' : Number(e.target.value))} id="t-ply" />
                <Input label="Target Count" value={form.target_count} placeholder="e.g. 40/2"
                  onChange={(e) => setF('target_count', e.target.value)} id="t-count" />
                <Input label="TPI" type="number" step="0.001" value={form.tpi}
                  onChange={(e) => setF('tpi', e.target.value === '' ? '' : Number(e.target.value))} id="t-tpi" />
                <Input label="Spindle Speed" value={form.spindle_speed}
                  onChange={(e) => setF('spindle_speed', e.target.value)} id="t-spindle" />
                <Input label="Operator" value={form.operator}
                  onChange={(e) => setF('operator', e.target.value)} id="t-op" />
              </div>
            )}
          </div>

          <Textarea label="Remarks" value={form.remarks}
            onChange={(e) => setF('remarks', e.target.value)} id="p-remarks" />
        </div>
      </Modal>

      {/* ── Detail ─────────────────────────────────────────── */}
      <Modal open={detailId != null} onClose={() => setDetailId(null)} size="lg"
        title={detail ? `${detail.process_no} — ${PROC_LABEL[detail.process_type as ProcType]}` : 'Process'}>
        {!detail ? <LoadingBlock label="Loading…" /> : (
          <div className="space-y-4 text-[12px]">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Info label="Status" value={<Badge tone={STATUS_TONE[detail.status] ?? 'slate'}>{detail.status.replace(/_/g, ' ')}</Badge>} />
              <Info label="Yarn" value={detail.yarn_code ? `${detail.yarn_code} — ${detail.yarn_name}` : '—'} />
              <Info label="Input KG" value={fmtDecimal(detail.input_qty_kg, 3)} />
              <Info label="Expected Output" value={fmtDecimal(detail.expected_output, 3)} />
              <Info label="Loss %" value={fmtDecimal(detail.expected_loss_pct, 3)} />
              <Info label="Required" value={fmtDate(detail.required_date)} />
              <Info label="Unit" value={detail.job_work_type === 'JOB_WORK' ? `Job Work — ${detail.vendor_name ?? ''}` : 'Internal'} />
              <Info label="Part" value={detail.part_name || '—'} />
            </div>

            <Section title={`Reservations (${detail.reservations?.length ?? 0})`}>
              {(detail.reservations ?? []).length === 0 ? <Muted>No reservations</Muted> : (
                <SimpleTable head={['Yarn', 'Required', 'Reserved', 'Consumed', 'Status']}
                  rows={(detail.reservations ?? []).map((r: any) => [
                    r.yarn_code ?? '—', fmtDecimal(r.required_qty_kg, 3), fmtDecimal(r.reserved_qty_kg, 3),
                    fmtDecimal(r.released_qty_kg, 3), r.status,
                  ])} />
              )}
            </Section>

            <Section title={`Issues (${detail.issues?.length ?? 0})`}>
              {(detail.issues ?? []).length === 0 ? <Muted>No yarn issued yet</Muted> : (
                <SimpleTable head={['Issue No', 'Date', 'Lot', 'Yarn PO', 'KG', 'Override']}
                  rows={(detail.issues ?? []).map((i: any) => [
                    i.issue_no, fmtDate(i.issue_date), i.lot_no ?? '—', i.yarn_po_no ?? '—',
                    fmtDecimal(i.issued_qty_kg, 3),
                    i.is_override ? <span className="text-amber-700 font-semibold">Yes</span> : 'No',
                  ])} />
              )}
            </Section>

            <Section title={`Receipts (${detail.receipts?.length ?? 0})`}>
              {(detail.receipts ?? []).length === 0 ? <Muted>No output received yet</Muted> : (
                <div className="space-y-2">
                  {(detail.receipts ?? []).map((r: any) => (
                    <div key={r.id} className="rounded border border-slate-200 p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-brand-700">{r.receipt_no}</span>
                        <Badge tone={r.qc_status === 'PASSED' ? 'emerald' : r.qc_status === 'REJECTED' ? 'rose' : 'amber'}>
                          QC {r.qc_status}
                        </Badge>
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5 text-[11px]">
                        <Info label="Input" value={fmtDecimal(r.input_qty, 3)} />
                        <Info label="Output" value={fmtDecimal(r.output_qty, 3)} />
                        <Info label="Loss" value={fmtDecimal(r.loss_qty, 3)} />
                        <Info label="Rejected" value={fmtDecimal(r.rejected_qty, 3)} />
                        <Info label="Output Lot" value={r.output_lot_no ?? '—'} />
                      </div>
                      {(r.cones ?? []).length > 0 && (
                        <div className="mt-2">
                          <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                            Cones ({r.cones.length})
                          </p>
                          <SimpleTable head={['Cone', 'Source Lot', 'KG', 'Status']}
                            rows={r.cones.map((c: any) => [
                              c.cone_no, c.source_lot_no ?? '—', fmtDecimal(c.weight_kg, 3), c.status,
                            ])} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title={`QC (${detail.qc?.length ?? 0})`}>
              {(detail.qc ?? []).length === 0 ? <Muted>No QC recorded</Muted> : (
                <div className="space-y-2">
                  {(detail.qc ?? []).map((q: any) => (
                    <div key={q.id} className="rounded border border-slate-200 p-2">
                      <div className="flex items-center justify-between">
                        <span>{fmtDate(q.qc_date)}</span>
                        <Badge tone={q.overall_status === 'PASSED' ? 'emerald' : 'amber'}>{q.overall_status}</Badge>
                      </div>
                      {(q.lines ?? []).length > 0 && (
                        <SimpleTable head={['Parameter', 'Expected', 'Actual', 'Result']}
                          rows={q.lines.map((l: any) => [
                            l.parameter, l.expected_value ?? '—', l.actual_value ?? '—', l.result,
                          ])} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </Modal>
    </div>
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
