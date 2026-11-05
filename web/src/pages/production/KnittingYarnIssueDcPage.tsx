import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Copy, Save, CheckCircle2, Eye, Download, Printer, Ban, Truck, Paperclip, History, FileText, X, AlertTriangle,
} from 'lucide-react';
import { api, http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { Badge, Input, LoadingBlock, Modal, PageHeader, Select, Textarea } from '../../components/ui';
import { PrintTemplatePicker, printTemplateParam, usePrintTemplate, type PrintTemplateChoice } from '../../components/PrintTemplatePicker';

/**
 * Knitting – Yarn Issue / Delivery Challan (C-ONE ERP specification, 04-Nov-2026).
 * One DC carries many jobs (IO) and yarn / lot lines to one knitting contractor. Draft → Approve (yarn leaves
 * stock) → print the A4 portrait PDF (server-rendered, so the paper size never changes). No rate, amount or
 * gross weight on this DC — the knitting rate comes from the approved quotation at fabric inward.
 */

const DC_READY = ['RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED'];
const BASE = '/knitting/yarn-issue-dcs';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ─────────────────────────── PDF helpers ─────────────────────────── */
type PdfPurpose = 'preview' | 'print' | 'download';
export async function fetchKnitDcPdf(id: number, purpose: PdfPurpose = 'preview', template: PrintTemplateChoice = '') {
  const r = await api.get<Blob>(`${BASE}/${id}/print`, {
    params: { purpose, ...printTemplateParam(template) }, responseType: 'blob', timeout: 60_000, validateStatus: (s) => s !== 401 && s < 500,
  });
  if (r.status !== 200) {
    let msg = `Could not make the PDF (HTTP ${r.status})`;
    try { msg = JSON.parse(await (r.data as Blob).text())?.error?.message ?? msg; } catch { /* not JSON */ }
    throw new ApiError(r.status, 'PDF_FAILED', msg);
  }
  const name = /filename="([^"]+)"/.exec(String(r.headers['content-disposition'] ?? ''))?.[1] ?? `KDC-${id}.pdf`;
  return { blob: new Blob([r.data], { type: 'application/pdf' }), name };
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
/** Prints the PDF itself (A4 portrait page size is inside the PDF) through a hidden frame. */
function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const f = document.createElement('iframe');
  f.style.position = 'fixed'; f.style.right = '0'; f.style.bottom = '0'; f.style.width = '0'; f.style.height = '0'; f.style.border = '0';
  f.src = url;
  f.onload = () => { try { f.contentWindow?.focus(); f.contentWindow?.print(); } catch { window.open(url, '_blank'); } };
  document.body.appendChild(f);
  setTimeout(() => { f.remove(); URL.revokeObjectURL(url); }, 120_000);
}

/** A4 PDF preview of a knitting yarn issue DC, with Download / Print (print counts as a print / reprint). */
export function KnitDcPdfModal({ id, title, onClose }: { id: number | null; title?: string; onClose: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = usePrintTemplate();   // Colour / Black & White (client 05-Nov-2026)
  useEffect(() => {
    if (!id) return;
    let alive = true; let made: string | null = null;
    setUrl(null);
    fetchKnitDcPdf(id, 'preview', template).then(({ blob }) => { if (alive) { made = URL.createObjectURL(blob); setUrl(made); } })
      .catch((e) => toast(errMsg(e), 'error'));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [id, template]);
  const run = async (p: PdfPurpose) => {
    if (!id) return;
    setBusy(true);
    try { const { blob, name } = await fetchKnitDcPdf(id, p, template); if (p === 'download') saveBlob(blob, name); else printBlob(blob); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!id} onClose={onClose} size="xl" title={title ?? 'Knitting yarn issue DC'} subtitle="A4 portrait — print preview" icon={<FileText size={16} />}
      footer={<>
        <PrintTemplatePicker value={template} onChange={setTemplate} id="kdc-print-template" className="mr-auto" />
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-secondary" disabled={busy} onClick={() => run('download')} id="btn-kdc-pdf-download"><Download size={14} /> Download PDF</button>
        <button className="btn-primary" disabled={busy} onClick={() => run('print')} id="btn-kdc-pdf-print"><Printer size={14} /> Print</button>
      </>}>
      {url ? <iframe title="DC PDF" src={url} className="h-[72vh] w-full rounded border border-surface-border" id="kdc-pdf-frame" /> : <LoadingBlock rows={6} />}
    </Modal>
  );
}

/* ─────────────────────────── shared bits ─────────────────────────── */
const DOC_TONE: Record<string, string> = { DRAFT: 'amber', APPROVED: 'green', CANCELLED: 'red' };
const EWB_VIEW: Record<string, { label: string; tone: string }> = {
  NOT_REQUIRED: { label: 'EWB not required', tone: 'slate' }, PENDING: { label: 'EWB pending details', tone: 'amber' },
  ENTERED: { label: 'EWB entered', tone: 'green' }, EXPIRED: { label: 'EWB expired', tone: 'red' }, CANCELLED: { label: 'EWB cancelled', tone: 'red' },
};

/** GSTIN / transporter ID check (format + check character), same rule as the server. */
function gstinOk(v: string) {
  const g = v.toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  const cs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = cs.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return cs[(36 - (sum % 36)) % 36] === g[14];
}

/* ─────────────────────────── list ─────────────────────────── */
function DcList() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: contractors = [] } = useLookup('process-units');
  const [f, setF] = useState({ from: '', to: '', dc_no: '', contractor_id: '', job: '', status: '' });
  const [pdfId, setPdfId] = useState<number | null>(null);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['knit-yarn-dcs', qs],
    queryFn: async () => (await http.get<{ data: any[] }>(`${BASE}${qs ? `?${qs}` : ''}`)).data ?? [],
  });
  return (
    <div>
      <PageHeader title="Knitting Yarn Issue DC" subtitle="Yarn going out to the knitting contractor — one DC can carry many jobs. Rate is not on the DC; it is taken from the approved quotation at fabric inward."
        actions={can('PROCESS.ISSUE') ? <button className="btn-primary" onClick={() => nav('/production/knitting-yarn-dcs/new')} id="btn-new-kyd"><Plus size={14} /> New Yarn Issue DC</button> : null} />
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-surface-border bg-white p-3 sm:grid-cols-3 lg:grid-cols-6">
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} id="kyd-f-from" />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} id="kyd-f-to" />
        <Input label="DC No" value={f.dc_no} onChange={(e) => setF({ ...f, dc_no: e.target.value })} id="kyd-f-dcno" />
        <Select label="Contractor" value={f.contractor_id} placeholder="All" onChange={(e) => setF({ ...f, contractor_id: e.target.value })} id="kyd-f-contractor">
          {contractors.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <Input label="Job (IO) No" value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} id="kyd-f-job" />
        <Select label="Status" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })} id="kyd-f-status"
          options={[{ value: 'DRAFT', label: 'Draft' }, { value: 'APPROVED', label: 'Approved' }, { value: 'CANCELLED', label: 'Cancelled' }]} />
      </div>
      {isLoading ? <LoadingBlock rows={6} /> : (
        <div className="overflow-x-auto rounded-lg border border-surface-border bg-white">
          <table className="w-full text-small" id="kyd-list">
            <thead className="bg-surface-muted"><tr>
              <th className="th">DC No</th><th className="th">Date</th><th className="th">Contractor</th><th className="th">Jobs</th>
              <th className="th text-right">Lines</th><th className="th text-right">Cones</th><th className="th text-right">Net KG</th>
              <th className="th">Vehicle</th><th className="th">Status</th><th className="th">E-way bill</th><th className="th" />
            </tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={11} className="td py-6 text-center text-ink-muted">No yarn issue DCs</td></tr>}
              {rows.map((r: any) => {
                const ev = EWB_VIEW[r.ewb_view_status] ?? EWB_VIEW.NOT_REQUIRED;
                return (
                  <tr key={r.id} className="cursor-pointer border-t border-surface-divider hover:bg-surface-hover" onClick={() => nav(`/production/knitting-yarn-dcs/${r.id}`)} id={`kyd-row-${r.id}`}>
                    <td className="td font-semibold text-brand-700 tabular-nums">{r.dc_no}</td>
                    <td className="td text-ink-secondary">{fmtDate(r.dc_date)}</td>
                    <td className="td">{r.contractor ?? '—'}</td>
                    <td className="td max-w-[260px] text-caption">{r.jobs ?? '—'}</td>
                    <td className="td text-right tabular-nums">{r.line_count}</td>
                    <td className="td text-right tabular-nums">{r.total_cones}</td>
                    <td className="td text-right tabular-nums font-semibold">{fmtDecimal(r.total_net_kg, 2)}</td>
                    <td className="td">{r.vehicle_no ?? '—'}</td>
                    <td className="td"><Badge tone={DOC_TONE[r.doc_status] ?? 'slate'}>{r.doc_status}</Badge>{Number(r.print_count) > 0 && <span className="ml-1 text-micro text-ink-muted">printed {r.print_count}×</span>}</td>
                    <td className="td whitespace-nowrap"><Badge tone={ev.tone}>{ev.label}</Badge>{r.eway_bill_no ? <span className="block text-micro text-ink-muted">{r.eway_bill_no}</span> : null}</td>
                    <td className="td" onClick={(e) => e.stopPropagation()}>
                      <button className="rounded p-1 text-ink-muted hover:bg-brand-50 hover:text-brand-600" title="Print preview" onClick={() => setPdfId(r.id)} id={`kyd-pdf-${r.id}`}><Eye size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <KnitDcPdfModal id={pdfId} onClose={() => setPdfId(null)} />
    </div>
  );
}

/* ─────────────────────────── editor ─────────────────────────── */
interface JobDefaults {
  program_id: number; program_no: string; io_no: string | null; job_no: string; status: string; ready: boolean; vendor_id: number | null;
  fabric_description: string;
  yarns: { program_yarn_id: number; yarn_id: number; yarn_code: string; yarn_name: string; colour: string | null; pending_kg: number; yarn_description: string; substitutes: { yarn_id: number; yarn_name: string }[] }[];
  lots: any[];
}
interface DcLine {
  key: string; id?: number; program_id: string; program_yarn_id: string; yarn_id: string; grn_line_id: string; lot_no?: string | null;
  yarn_description: string; fabric_description: string; cones: string; net_weight_kg: string;
}
let seq = 0;
const nk = () => `l${++seq}`;
const emptyLine = (): DcLine => ({ key: nk(), program_id: '', program_yarn_id: '', yarn_id: '', grn_line_id: '', yarn_description: '', fabric_description: '', cones: '', net_weight_kg: '' });

function DcEditor({ id }: { id: number | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { data: contractors = [] } = useLookup('process-units');
  const { data: warehouses = [] } = useLookup('warehouses');
  const { data: programs = [] } = useQuery({
    queryKey: ['knitting-programs', 'dc-ready-all'],
    queryFn: async () => (await http.get<{ data: any[] }>('/knitting/programs?pageSize=300')).data ?? [],
  });
  const { data: dc, isLoading, refetch } = useQuery({
    queryKey: ['knit-yarn-dc', id],
    queryFn: async () => (await http.get<{ data: any }>(`${BASE}/${id}`)).data,
    enabled: !!id,
  });
  const [h, setH] = useState<any>({ dc_date: today(), vendor_id: '', contractor_address: '', vehicle_no: '', purpose: 'Yarn Issue for Knitting', warehouse_id: '', remarks: '', allow_override: false, override_reason: '' });
  const [lines, setLines] = useState<DcLine[]>([]);
  const [defs, setDefs] = useState<Record<string, JobDefaults>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [ask, setAsk] = useState<null | { title: string; label: string; onOk: (reason: string) => Promise<void> }>(null);
  const loaded = useRef<number | null>(null);

  const status: string = dc?.doc_status ?? 'NEW';
  const isDraft = status === 'NEW' || status === 'DRAFT';
  const isApproved = status === 'APPROVED';
  const editApproved = isApproved && can('KNIT_DC.EDIT_APPROVED');
  const canDesc = can('KNIT_DC.EDIT_DESC') || editApproved;
  const headerEditable = isDraft ? can('PROCESS.ISSUE') : editApproved;

  const loadDefaults = async (pid: string | number) => {
    const k = String(pid);
    if (!k || defs[k]) return defs[k];
    const d = (await http.get<{ data: JobDefaults }>(`${BASE}/job-defaults/${k}`)).data;
    setDefs((x) => ({ ...x, [k]: d }));
    return d;
  };

  // existing DC → form
  useEffect(() => {
    if (!dc || loaded.current === dc.id) return;
    loaded.current = dc.id;
    setH({ dc_date: String(dc.dc_date).slice(0, 10), vendor_id: String(dc.vendor_id ?? ''), contractor_address: dc.contractor_address_snapshot ?? '', vehicle_no: dc.vehicle_no ?? '',
      purpose: dc.purpose ?? '', warehouse_id: String(dc.warehouse_id ?? ''), remarks: dc.remarks ?? '', allow_override: !!dc.allow_override, override_reason: dc.override_reason ?? '' });
    setLines(dc.lines.map((l: any) => ({ key: nk(), id: l.id, program_id: String(l.program_id), program_yarn_id: l.program_yarn_id ? String(l.program_yarn_id) : '', yarn_id: String(l.yarn_id),
      grn_line_id: l.grn_line_id ? String(l.grn_line_id) : '', lot_no: l.lot_no, yarn_description: l.yarn_description_snapshot ?? '', fabric_description: l.fabric_description_snapshot ?? '',
      cones: String(l.cones ?? 0), net_weight_kg: String(l.net_weight_kg ?? '') })));
    [...new Set(dc.lines.map((l: any) => String(l.program_id)))].forEach((p) => { void loadDefaults(p as string).catch(() => {}); });
    setDirty(false);
  }, [dc]);

  // new DC from a program (?program_id=)
  useEffect(() => {
    if (id) return;
    const pid = sp.get('program_id');
    const l = emptyLine();
    setLines([l]);
    if (pid) void pickJob(l.key, pid, true);
  }, [id]);

  const setLine = (key: string, patch: Partial<DcLine>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true); };
  const lotsFor = (l: DcLine) => (defs[l.program_id]?.lots ?? []).filter((o: any) => String(o.yarn_id) === l.yarn_id);
  const usedOnLot = (grn: string, except: string) => lines.filter((x) => x.key !== except && x.grn_line_id === grn).reduce((a, x) => a + (Number(x.net_weight_kg) || 0), 0);

  async function pickJob(key: string, pid: string, first = false) {
    setLine(key, { program_id: pid, program_yarn_id: '', yarn_id: '', grn_line_id: '', yarn_description: '', fabric_description: '' });
    if (!pid) return;
    try {
      const d = await loadDefaults(pid);
      if (!d) return;
      const y = d.yarns[0];
      const lots = d.lots.filter((o: any) => y && Number(o.yarn_id) === Number(y.yarn_id));
      const lot = lots.find((o: any) => o.available_kg > 0.0005);
      setLines((ls) => ls.map((l) => (l.key !== key ? l : {
        ...l, program_id: pid, program_yarn_id: y ? String(y.program_yarn_id) : '', yarn_id: y ? String(y.yarn_id) : '',
        yarn_description: y?.yarn_description ?? '', fabric_description: d.fabric_description, grn_line_id: lot ? String(lot.grn_line_id) : '',
        net_weight_kg: l.net_weight_kg || (y && lot ? String(Math.round(Math.min(y.pending_kg || lot.available_kg, lot.available_kg) * 1000) / 1000) : ''),
      })));
      if (first && d.vendor_id && !h.vendor_id) await pickContractor(String(d.vendor_id));
      if (!d.ready) toast(`Program ${d.program_no} is ${d.status.toLowerCase().replace(/_/g, ' ')} — release it before approving the DC`, 'warning');
    } catch (e) { toast(errMsg(e), 'error'); }
  }
  function pickYarn(l: DcLine, v: string) {
    const [py, yid] = v.split('|');
    const d = defs[l.program_id];
    const y = d?.yarns.find((x) => String(x.program_yarn_id) === py);
    const sub = y && String(y.yarn_id) !== yid ? y.substitutes.find((x) => String(x.yarn_id) === yid) : null;
    const desc = sub ? `${sub.yarn_name}${y?.colour ? ` (${y.colour})` : ''}` : (y?.yarn_description ?? '');
    const lot = (d?.lots ?? []).find((o: any) => String(o.yarn_id) === yid && o.available_kg > 0.0005);
    setLine(l.key, { program_yarn_id: py, yarn_id: yid, yarn_description: desc, grn_line_id: lot ? String(lot.grn_line_id) : '' });
  }
  async function pickContractor(v: string) {
    setH((x: any) => ({ ...x, vendor_id: v }));
    setDirty(true);
    if (!v) return;
    try {
      const c = (await http.get<{ data: any }>(`${BASE}/contractor/${v}`)).data;
      setH((x: any) => ({ ...x, vendor_id: v, vendor_name: c?.name ?? '', contractor_address: c?.address ?? '' }));
    } catch { /* address stays as typed */ }
  }

  const totals = useMemo(() => ({
    cones: lines.reduce((a, l) => a + (Number(l.cones) || 0), 0),
    kg: Math.round(lines.reduce((a, l) => a + (Number(l.net_weight_kg) || 0), 0) * 1000) / 1000,
    jobs: new Set(lines.map((l) => l.program_id).filter(Boolean)).size,
  }), [lines]);

  const payload = (reason?: string) => ({
    dc_date: h.dc_date, vendor_id: Number(h.vendor_id) || null, contractor_address: h.contractor_address || null, vehicle_no: h.vehicle_no || null, purpose: h.purpose || null,
    warehouse_id: Number(h.warehouse_id) || null, remarks: h.remarks || null, allow_override: !!h.allow_override, override_reason: h.override_reason || null, reason: reason ?? null,
    lines: lines.map((l) => ({ id: l.id ?? null, program_id: Number(l.program_id) || null, program_yarn_id: Number(l.program_yarn_id) || null, yarn_id: Number(l.yarn_id) || null,
      grn_line_id: Number(l.grn_line_id) || null, yarn_description: l.yarn_description || null, fabric_description: l.fabric_description || null,
      cones: l.cones === '' ? 0 : Number(l.cones), net_weight_kg: Number(l.net_weight_kg) })),
  });

  const check = () => {
    if (!h.vendor_id) return 'Select the knitting contractor';
    if (!h.warehouse_id) return 'Select the store the yarn goes out from';
    if (!lines.length) return 'Add at least one line';
    for (const [i, l] of lines.entries()) {
      if (!l.program_id) return `Line ${i + 1}: pick the job`;
      if (!l.yarn_id) return `Line ${i + 1}: pick the yarn`;
      if (!(Number(l.net_weight_kg) > 0)) return `Line ${i + 1}: enter the net weight`;
      if (l.cones !== '' && (!Number.isInteger(Number(l.cones)) || Number(l.cones) < 0)) return `Line ${i + 1}: cones must be a whole number, 0 or more`;
      if (!l.grn_line_id && !h.allow_override) return `Line ${i + 1}: pick the yarn lot`;
    }
    return null;
  };

  const saveDraft = async (): Promise<number | null> => {
    const bad = check(); if (bad) { toast(bad, 'error'); return null; }
    setBusy(true);
    try {
      if (!id) {
        const r = await http.post<{ data: { id: number; dc_no: string } }>(BASE, payload());
        toast(`Draft ${r.data.dc_no} saved`);
        void qc.invalidateQueries({ queryKey: ['knit-yarn-dcs'] });
        setDirty(false);
        nav(`/production/knitting-yarn-dcs/${r.data.id}`, { replace: true });
        return r.data.id;
      }
      await http.put(`${BASE}/${id}`, payload());
      toast('Draft saved'); setDirty(false); loaded.current = null; await refetch();
      return id;
    } catch (e) { toast(errMsg(e), 'error'); return null; } finally { setBusy(false); }
  };
  const saveApproved = () => setAsk({ title: `Change approved DC ${dc?.dc_no}`, label: 'Reason for the change', onOk: async (reason) => {
    await http.put(`${BASE}/${id}`, payload(reason));
    toast('Changes saved (audited)'); setDirty(false); loaded.current = null; await refetch();
  } });
  const approve = async () => {
    let did = id;
    if (!did || dirty) did = await saveDraft();
    if (!did) return;
    if (!window.confirm(`Approve and issue ${totals.kg.toFixed(3)} KG of yarn (${totals.cones} cones, ${totals.jobs} job(s)) to the contractor? Stock moves now.`)) return;
    setBusy(true);
    try {
      await http.post(`${BASE}/${did}/approve`, {});
      toast('DC approved — yarn issued');
      for (const k of ['knit-yarn-dcs', 'knit-dcs', 'knit-recon', 'knitting-programs']) void qc.invalidateQueries({ queryKey: [k] });
      loaded.current = null; await refetch();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const [printTemplate, setPrintTemplate] = usePrintTemplate();   // Colour / Black & White for Print / Download
  const cancelDc = () => setAsk({ title: `Cancel DC ${dc?.dc_no}`, label: isApproved ? 'Reason (the issued yarn goes back to stock)' : 'Reason', onOk: async (reason) => {
    const r = await http.post<{ data: any }>(`${BASE}/${id}/cancel`, { reason });
    toast(r.data.eway_warning ?? `DC cancelled${r.data.lines_reversed ? ` — ${fmtDecimal(r.data.stock_reversed_kg, 3)} KG back in stock` : ''}`, r.data.eway_warning ? 'warning' : 'success');
    for (const k of ['knit-yarn-dcs', 'knit-dcs', 'knit-recon']) void qc.invalidateQueries({ queryKey: [k] });
    loaded.current = null; await refetch();
  } });
  const pdf = async (p: PdfPurpose) => {
    if (!id) return;
    try { const { blob, name } = await fetchKnitDcPdf(id, p, printTemplate); if (p === 'download') saveBlob(blob, name); else printBlob(blob); if (p !== 'preview') void refetch(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };

  if (id && (isLoading || !dc)) return <LoadingBlock rows={8} />;
  const progOptions = programs.filter((p: any) => DC_READY.includes(p.status) || lines.some((l) => l.program_id === String(p.id)));
  const lineLocked = !isDraft;

  return (
    <div>
      <PageHeader
        breadcrumb={['Yarn & Knitting', 'Knitting Yarn Issue DC']}
        title={id ? `Yarn Issue DC ${dc.dc_no}` : 'New Knitting Yarn Issue DC'}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          {id ? <Badge tone={DOC_TONE[status] ?? 'slate'}>{status}</Badge> : <Badge tone="slate">NEW</Badge>}
          {isApproved && <span>Approved {fmtDateTime(dc.approved_at)}{dc.approved_by_name ? ` by ${dc.approved_by_name}` : ''}{Number(dc.print_count) > 0 ? ` · printed ${dc.print_count}×` : ''}</span>}
          {status === 'CANCELLED' && <span className="text-red-700">Cancelled: {dc.cancel_reason}</span>}
          {dirty && <span className="text-amber-700">Unsaved changes</span>}
        </span>}
        actions={<>
          <Link to="/production/knitting-yarn-dcs" className="btn-secondary"><X size={14} /> Close</Link>
          {id && <PrintTemplatePicker value={printTemplate} onChange={setPrintTemplate} id="kyd-print-template" />}
          {id && <button className="btn-secondary" onClick={() => setPdfOpen(true)} id="btn-kyd-preview"><Eye size={14} /> Print Preview</button>}
          {id && <button className="btn-secondary" onClick={() => pdf('download')} id="btn-kyd-download"><Download size={14} /> Download PDF</button>}
          {isApproved && <button className="btn-secondary" onClick={() => pdf('print')} id="btn-kyd-print"><Printer size={14} /> {Number(dc.print_count) > 0 ? 'Reprint' : 'Print'}</button>}
          {id && status !== 'CANCELLED' && can('KNIT_DC.CANCEL') && <button className="btn-secondary text-red-700" onClick={cancelDc} id="btn-kyd-cancel"><Ban size={14} /> Cancel DC</button>}
          {isDraft && can('PROCESS.ISSUE') && <button className="btn-secondary" disabled={busy} onClick={() => void saveDraft()} id="btn-kyd-save"><Save size={14} /> Save Draft</button>}
          {editApproved && <button className="btn-secondary" disabled={busy || !dirty} onClick={saveApproved} id="btn-kyd-save-approved"><Save size={14} /> Save Changes</button>}
          {isDraft && can('KNIT_DC.APPROVE') && <button className="btn-primary" disabled={busy} onClick={() => void approve()} id="btn-kyd-approve"><CheckCircle2 size={14} /> Approve &amp; Issue</button>}
        </>} />

      {/* header */}
      <div className="mb-4 rounded-lg border border-surface-border bg-white p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Input label="DC No" value={id ? dc.dc_no : 'Auto number on save'} readOnly disabled id="kyd-dcno" />
          <Input label="DC Date" type="date" required value={h.dc_date} disabled={!isDraft || !headerEditable} onChange={(e) => { setH({ ...h, dc_date: e.target.value }); setDirty(true); }} id="kyd-date" />
          <Select label="Contractor (knitter)" required value={h.vendor_id} placeholder="— Select —" disabled={!isDraft || !headerEditable}
            onChange={(e) => void pickContractor(e.target.value)} id="kyd-contractor">
            {contractors.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            {/* the program's / DC's knitter even when the party is not flagged job worker in the master */}
            {h.vendor_id && !contractors.some((p) => String(p.id) === String(h.vendor_id)) && <option value={h.vendor_id}>{h.vendor_name || dc?.contractor_name_snapshot || `Party #${h.vendor_id}`}</option>}
          </Select>
          <Select label="From Store" required value={h.warehouse_id} placeholder="— Select —" disabled={!isDraft || !headerEditable}
            onChange={(e) => { setH({ ...h, warehouse_id: e.target.value }); setDirty(true); }} id="kyd-store">
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </Select>
          <Textarea label="Contractor Address" rows={2} className="md:col-span-2" value={h.contractor_address} disabled={!headerEditable}
            onChange={(e) => { setH({ ...h, contractor_address: e.target.value }); setDirty(true); }} id="kyd-address" hint="Filled from the contractor master; saved on the DC" />
          <Input label="Vehicle No" value={h.vehicle_no} disabled={!headerEditable} onChange={(e) => { setH({ ...h, vehicle_no: e.target.value.toUpperCase() }); setDirty(true); }} id="kyd-vehicle" />
          <Input label="Purpose" value={h.purpose} disabled={!headerEditable} onChange={(e) => { setH({ ...h, purpose: e.target.value }); setDirty(true); }} id="kyd-purpose" />
        </div>
      </div>

      {/* e-way bill (between the header and the grid, as on the print) */}
      {id ? <EwbPanel dc={dc} onSaved={() => { void refetch(); }} /> : (
        <p className="mb-4 rounded-lg border border-dashed border-surface-border px-4 py-3 text-small text-ink-secondary">E-Way Bill: save the draft first, then enter the e-way bill details here.</p>
      )}

      {/* grid */}
      <div className="mb-3 overflow-x-auto rounded-lg border border-surface-border bg-white">
        <table className="w-full text-small" id="kyd-grid">
          <thead className="bg-surface-muted"><tr>
            <th className="th w-10">S.No</th><th className="th min-w-[180px]">Job No.</th><th className="th min-w-[200px]">Yarn</th><th className="th min-w-[220px]">Yarn Description</th>
            <th className="th min-w-[240px]">Fabric Description</th><th className="th min-w-[200px]">Lot No.</th><th className="th w-24 text-right">Cones</th>
            <th className="th w-28 text-right">Net Weight (KG)</th><th className="th w-20" />
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const d = defs[l.program_id];
              const yarnVal = l.program_yarn_id ? `${l.program_yarn_id}|${l.yarn_id}` : '';
              const lots = lotsFor(l);
              const lot = lots.find((o: any) => String(o.grn_line_id) === l.grn_line_id);
              const over = lot && !lineLocked && Number(l.net_weight_kg) + usedOnLot(l.grn_line_id, l.key) > Number(lot.available_kg) + 1e-6;
              return (
                <tr key={l.key} className="border-t border-surface-divider align-top" id={`kyd-line-${i}`}>
                  <td className="td text-center text-ink-secondary">{i + 1}</td>
                  <td className="td">
                    {lineLocked ? <span className="font-semibold">{dc.lines[i]?.job_no_snapshot ?? d?.job_no}</span> : (
                      <select className="input py-1 text-small" value={l.program_id} onChange={(e) => void pickJob(l.key, e.target.value)} id={`kyd-job-${i}`}>
                        <option value="">— Job / program —</option>
                        {progOptions.map((p: any) => <option key={p.id} value={p.id}>{p.io_no ?? 'stock'} · {p.program_no}</option>)}
                      </select>
                    )}
                    {d && <span className="mt-0.5 block text-micro text-ink-muted">Program {d.program_no}{!d.ready ? ` · ${d.status.toLowerCase().replace(/_/g, ' ')}` : ''}</span>}
                  </td>
                  <td className="td">
                    {lineLocked ? <span>{dc.lines[i]?.yarn_name ?? ''}</span> : (
                      <select className="input py-1 text-small" value={yarnVal} disabled={!d} onChange={(e) => pickYarn(l, e.target.value)} id={`kyd-yarn-${i}`}>
                        <option value="">— Yarn —</option>
                        {d?.yarns.flatMap((y) => [
                          <option key={`${y.program_yarn_id}|${y.yarn_id}`} value={`${y.program_yarn_id}|${y.yarn_id}`}>{y.yarn_name}{y.colour ? ` · ${y.colour}` : ''} · pending {fmtDecimal(y.pending_kg, 3)} KG</option>,
                          ...y.substitutes.map((s) => <option key={`${y.program_yarn_id}|${s.yarn_id}`} value={`${y.program_yarn_id}|${s.yarn_id}`}>[Approved substitute] {s.yarn_name}</option>),
                        ])}
                      </select>
                    )}
                  </td>
                  <td className="td">
                    <textarea className="input py-1 text-small" rows={2} value={l.yarn_description} readOnly={!canDesc || status === 'CANCELLED'} id={`kyd-ydesc-${i}`}
                      onChange={(e) => setLine(l.key, { yarn_description: e.target.value })} title={canDesc ? 'Saved on the DC as printed' : 'You may not change the description'} />
                  </td>
                  <td className="td">
                    <textarea className="input py-1 text-small" rows={2} value={l.fabric_description} readOnly={!canDesc || status === 'CANCELLED'} id={`kyd-fdesc-${i}`}
                      onChange={(e) => setLine(l.key, { fabric_description: e.target.value })} />
                  </td>
                  <td className="td">
                    {lineLocked ? <span className="tabular-nums">{l.lot_no ?? '—'}</span> : (
                      <select className="input py-1 text-small" value={l.grn_line_id} disabled={!l.yarn_id} onChange={(e) => setLine(l.key, { grn_line_id: e.target.value })} id={`kyd-lot-${i}`}>
                        <option value="">{lots.length ? '— Lot —' : 'No stock for this job'}</option>
                        {lots.map((o: any) => <option key={`${o.grn_line_id}-${o.holder_so_id}`} value={o.grn_line_id}>{o.lot_no ?? '(no lot no)'} · {o.grn_no} · {fmtDecimal(o.available_kg, 3)} KG ({o.holder_job})</option>)}
                      </select>
                    )}
                  </td>
                  <td className="td"><input className="input w-20 text-right" type="number" min={0} step={1} value={l.cones} disabled={lineLocked}
                    onChange={(e) => setLine(l.key, { cones: e.target.value })} id={`kyd-cones-${i}`} /></td>
                  <td className="td"><input className={`input w-28 text-right ${over ? 'border-red-400 text-red-700' : ''}`} type="number" min={0} step={0.001} value={l.net_weight_kg} disabled={lineLocked}
                    onChange={(e) => setLine(l.key, { net_weight_kg: e.target.value })} id={`kyd-kg-${i}`} title={over ? 'More than the lot holds' : undefined} /></td>
                  <td className="td whitespace-nowrap">
                    {!lineLocked && <>
                      <button className="rounded p-1 text-ink-muted hover:bg-brand-50 hover:text-brand-600" title="Duplicate line" id={`kyd-dup-${i}`}
                        onClick={() => { setLines((ls) => { const c = [...ls]; c.splice(i + 1, 0, { ...l, key: nk(), id: undefined }); return c; }); setDirty(true); }}><Copy size={14} /></button>
                      <button className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600" title="Remove line" id={`kyd-del-${i}`}
                        onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true); }}><Trash2 size={14} /></button>
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-surface-border bg-surface-muted font-semibold">
              <td className="td" colSpan={6}>
                {!lineLocked && <button className="btn-secondary btn-sm" onClick={() => { setLines((ls) => [...ls, emptyLine()]); setDirty(true); }} id="btn-kyd-add-line"><Plus size={13} /> Add Line</button>}
                <span className="ml-3 text-ink-secondary">{totals.jobs} job(s) · {lines.length} line(s)</span>
                <span className="float-right">Total</span>
              </td>
              <td className="td text-right tabular-nums" id="kyd-total-cones">{totals.cones}</td>
              <td className="td text-right tabular-nums" id="kyd-total-kg">{fmtDecimal(totals.kg, 2)}</td>
              <td className="td" />
            </tr>
          </tfoot>
        </table>
      </div>
      {isDraft && (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <label className="flex items-center gap-2 text-small text-ink">
              <input type="checkbox" checked={!!h.allow_override} onChange={(e) => { setH({ ...h, allow_override: e.target.checked }); setDirty(true); }} id="kyd-override" />
              Issue beyond available stock (needs authorisation)
            </label>
            {h.allow_override && <Input label="Override reason" required className="mt-2" value={h.override_reason} onChange={(e) => { setH({ ...h, override_reason: e.target.value }); setDirty(true); }} id="kyd-override-reason" />}
          </div>
          <Textarea label="Remarks (not printed)" rows={2} value={h.remarks} onChange={(e) => { setH({ ...h, remarks: e.target.value }); setDirty(true); }} id="kyd-remarks" />
        </div>
      )}
      {id && <AuditPanel id={id} />}

      <KnitDcPdfModal id={pdfOpen ? id : null} title={dc ? `Yarn Issue DC ${dc.dc_no}` : undefined} onClose={() => { setPdfOpen(false); void refetch(); }} />
      <ReasonModal ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

function ReasonModal({ ask, onClose }: { ask: null | { title: string; label: string; onOk: (reason: string) => Promise<void> }; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); }, [ask]);
  return (
    <Modal open={!!ask} onClose={onClose} size="sm" title={ask?.title ?? ''} icon={<AlertTriangle size={16} />}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className="btn-primary" disabled={busy || reason.trim().length < 5} id="btn-reason-ok" onClick={async () => {
          setBusy(true);
          try { await ask!.onOk(reason.trim()); onClose(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
        }}>Confirm</button>
      </>}>
      <Textarea label={ask?.label ?? 'Reason'} required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} id="kyd-reason" hint="At least 5 characters — kept in the audit history" />
    </Modal>
  );
}

/* ─────────────────────────── e-way bill panel ─────────────────────────── */
function EwbPanel({ dc, onSaved }: { dc: any; onSaved: () => void }) {
  const toast = useToast();
  const { data: transporters = [] } = useLookup('transporters');
  const e0 = dc.eway ?? {};
  const [f, setF] = useState<any>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setF({ is_required: !!e0.is_required, eway_bill_no: e0.eway_bill_no ?? '', eway_bill_datetime: e0.eway_bill_datetime_local ?? '', valid_until: e0.valid_until_local ?? '',
      approx_distance_km: e0.approx_distance_km ?? '', transport_mode: e0.transport_mode ?? 'Road', transporter_party_id: e0.transporter_party_id ? String(e0.transporter_party_id) : '',
      transporter_gstin: e0.transporter_gstin ?? '', transporter_name: e0.transporter_name ?? '', same_as_dc_vehicle: e0.same_as_dc_vehicle ?? true,
      eway_vehicle_no: e0.eway_vehicle_no ?? '', reference_url: e0.reference_url ?? '', remarks: e0.remarks ?? '' });
    setReason('');
  }, [dc.eway]);
  const after = dc.doc_status === 'APPROVED';
  const locked = dc.doc_status === 'CANCELLED' || (after && !dc.permissions?.ewb_after_approval);
  const view = EWB_VIEW[e0.view_status] ?? EWB_VIEW.NOT_REQUIRED;
  const gstBad = !!f.transporter_gstin && !gstinOk(f.transporter_gstin);
  const set = (p: any) => setF((x: any) => ({ ...x, ...p }));

  const save = async () => {
    if (gstBad) { toast('Transporter GSTIN / ID is not valid', 'error'); return; }
    if (after && reason.trim().length < 5) { toast('Give the reason for changing the e-way bill of an approved DC', 'error'); return; }
    setBusy(true);
    try {
      await http.put(`${BASE}/${dc.id}/eway-bill`, { ...f, transporter_party_id: Number(f.transporter_party_id) || null, approx_distance_km: f.approx_distance_km === '' ? null : Number(f.approx_distance_km),
        change_reason: reason || null });
      toast('E-way bill details saved'); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const attach = async (file: File) => {
    if (after && reason.trim().length < 5) { toast('Give the reason (approved DC) before attaching', 'error'); return; }
    const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    setBusy(true);
    try { await http.post(`${BASE}/${dc.id}/eway-bill/attachment`, { filename: file.name, data, change_reason: reason || null }); toast('E-way bill document attached'); onSaved(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const viewDoc = async () => {
    try {
      const r = await api.get<Blob>(`${BASE}/${dc.id}/eway-bill/attachment`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: String(r.headers['content-type'] ?? 'application/pdf') }));
      window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const removeDoc = async () => {
    const why = window.prompt('Reason for removing the e-way bill document (min 5 characters):');
    if (!why || why.trim().length < 5) return;
    try { await http.del(`${BASE}/${dc.id}/eway-bill/attachment?reason=${encodeURIComponent(why.trim())}`); toast('Document removed (audited)'); onSaved(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="mb-4 rounded-lg border border-surface-border bg-white" id="kyd-ewb">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-divider px-4 py-2.5">
        <Truck size={15} className="text-brand-600" />
        <h3 className="text-body font-semibold text-ink">E-Way Bill</h3>
        <Badge tone={view.tone}>{view.label}</Badge>
        {e0.near_expiry && <Badge tone="amber">Expires within 6 hours</Badge>}
        {e0.view_status === 'EXPIRED' && <span className="text-caption font-semibold text-red-700">Expired {e0.valid_until_text} — extend it on the GST portal (this warning does not replace the portal's check)</span>}
        <label className="ml-auto flex items-center gap-3 text-small">
          <span className="text-ink-secondary">E-Way Bill required</span>
          <label className="flex items-center gap-1"><input type="radio" name="ewb-req" checked={!!f.is_required} disabled={locked} onChange={() => set({ is_required: true, transport_mode: f.transport_mode || 'Road' })} id="kyd-ewb-yes" /> Yes</label>
          <label className="flex items-center gap-1"><input type="radio" name="ewb-req" checked={!f.is_required} disabled={locked} onChange={() => set({ is_required: false })} id="kyd-ewb-no" /> No</label>
        </label>
      </div>
      <div className="px-4 py-3">
        {f.is_required && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Input label="E-Way Bill No" required value={f.eway_bill_no} disabled={locked} placeholder="12-digit number from the GST portal" onChange={(e) => set({ eway_bill_no: e.target.value })} id="kyd-ewb-no-input" />
            <Input label="E-Way Bill Date & Time (IST)" required type="datetime-local" value={f.eway_bill_datetime} disabled={locked} onChange={(e) => set({ eway_bill_datetime: e.target.value })} id="kyd-ewb-date" />
            <Input label="Valid Until (IST)" type="datetime-local" value={f.valid_until} disabled={locked} onChange={(e) => set({ valid_until: e.target.value })} id="kyd-ewb-valid" />
            <Input label="Approx. Distance (KM)" required type="number" min={1} value={f.approx_distance_km} disabled={locked} onChange={(e) => set({ approx_distance_km: e.target.value })} id="kyd-ewb-km" />
            <Select label="Transport Mode" required value={f.transport_mode} disabled={locked} onChange={(e) => set({ transport_mode: e.target.value })} id="kyd-ewb-mode"
              options={['Road', 'Rail', 'Air', 'Ship', 'Other'].map((m) => ({ value: m, label: m }))} />
            <Select label="Transporter (master)" value={f.transporter_party_id} placeholder="— Manual entry —" disabled={locked} id="kyd-ewb-transporter"
              onChange={(e) => { const t = transporters.find((x) => String(x.id) === e.target.value); set({ transporter_party_id: e.target.value, transporter_name: t ? String(t.party_name ?? t.label) : f.transporter_name, transporter_gstin: t?.gstin ? String(t.gstin) : f.transporter_gstin }); }}>
              {transporters.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
            <Input label="Transporter GSTIN / ID" value={f.transporter_gstin} disabled={locked} error={gstBad ? 'Not a valid GSTIN / transporter ID' : undefined}
              onChange={(e) => set({ transporter_gstin: e.target.value.toUpperCase() })} id="kyd-ewb-gstin" />
            <Input label="Transporter Name" value={f.transporter_name} disabled={locked} onChange={(e) => set({ transporter_name: e.target.value })} id="kyd-ewb-tname" />
            <div>
              <label className="label">E-Way Bill Vehicle No</label>
              <label className="mb-1 flex items-center gap-2 text-small"><input type="checkbox" checked={!!f.same_as_dc_vehicle} disabled={locked} onChange={(e) => set({ same_as_dc_vehicle: e.target.checked })} id="kyd-ewb-same" /> Same as DC vehicle ({dc.vehicle_no || '—'})</label>
              {!f.same_as_dc_vehicle && <input className="input" value={f.eway_vehicle_no} disabled={locked} onChange={(e) => set({ eway_vehicle_no: e.target.value.toUpperCase() })} id="kyd-ewb-vehicle" />}
            </div>
            <Input label="Reference URL" value={f.reference_url} disabled={locked} onChange={(e) => set({ reference_url: e.target.value })} id="kyd-ewb-url" />
            <Textarea label="Remarks" rows={2} className="md:col-span-2" value={f.remarks} disabled={locked} onChange={(e) => set({ remarks: e.target.value })} id="kyd-ewb-remarks" />
          </div>
        )}
        {!f.is_required && <p className="text-small text-ink-secondary">No e-way bill for this DC — nothing about it prints on the DC.</p>}
        {after && !locked && (
          <Input label="Reason for the change (approved DC)" required className="mt-3 max-w-xl" value={reason} onChange={(e) => setReason(e.target.value)} id="kyd-ewb-reason" />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!locked && <button className="btn-primary btn-sm" disabled={busy} onClick={() => void save()} id="btn-kyd-ewb-save"><Save size={13} /> Save E-Way Bill Details</button>}
          {!locked && e0.is_required && <>
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; if (x) void attach(x); }} id="kyd-ewb-file" />
            <button className="btn-secondary btn-sm" disabled={busy} onClick={() => fileRef.current?.click()} id="btn-kyd-ewb-attach"><Paperclip size={13} /> Attach E-Way Bill PDF</button>
          </>}
          {e0.has_attachment && <>
            <button className="btn-secondary btn-sm" onClick={() => void viewDoc()} id="btn-kyd-ewb-view"><Eye size={13} /> View / Download {e0.attachment_name}</button>
            {!locked && <button className="btn-secondary btn-sm text-red-700" onClick={() => void removeDoc()} id="btn-kyd-ewb-remove"><Trash2 size={13} /> Remove</button>}
          </>}
          <span className="text-caption text-ink-muted">
            {e0.has_qr ? 'QR from the official e-way bill response prints on the DC.' : 'No QR prints unless it comes from the official e-way bill response (manual entry prints the number only).'}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── audit ─────────────────────────── */
function AuditPanel({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['knit-yarn-dc-audit', id],
    queryFn: async () => (await http.get<{ data: { dc: any[]; eway: any[] } }>(`${BASE}/${id}/audit`)).data,
    enabled: open,
  });
  const rows = [...(data?.dc ?? []).map((r) => ({ ...r, kind: 'DC' })), ...(data?.eway ?? []).map((r) => ({ ...r, kind: 'E-way bill' }))]
    .sort((a, b) => String(b.action_at).localeCompare(String(a.action_at)));
  return (
    <div className="rounded-lg border border-surface-border bg-white">
      <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-body font-semibold text-ink" onClick={() => setOpen(!open)} id="btn-kyd-audit">
        <History size={15} className="text-brand-600" /> Audit history {open ? '' : '(show)'}
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-surface-divider">
          <table className="w-full text-small" id="kyd-audit">
            <thead className="bg-surface-muted"><tr><th className="th">When</th><th className="th">What</th><th className="th">Action</th><th className="th">By</th><th className="th">Reason / note</th><th className="th">Changes</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`} className="border-t border-surface-divider align-top">
                  <td className="td whitespace-nowrap text-ink-secondary">{fmtDateTime(r.action_at)}</td>
                  <td className="td">{r.kind}</td>
                  <td className="td font-semibold">{String(r.action).replace(/_/g, ' ')}</td>
                  <td className="td">{r.user_name ?? '—'}</td>
                  <td className="td max-w-[280px]">{r.remarks ?? '—'}</td>
                  <td className="td max-w-[420px] break-words text-caption text-ink-secondary">{changes(r.old_values_json, r.new_values_json)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
/** Short "field: old → new" summary of an audit row. */
function changes(o: unknown, n: unknown) {
  const p = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
  const a = p(o) as any; const b = p(n) as any;
  if (!b) return '';
  const flat = (x: any, pre = ''): Record<string, string> => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).flatMap(([k, v]) => Object.entries(flat(v, pre ? `${pre}.${k}` : k))))
    : { [pre]: Array.isArray(x) ? `${x.length} item(s)` : String(x ?? '—') });
  const fa = a ? flat(a) : {}; const fb = flat(b);
  const out = Object.keys(fb).filter((k) => fa[k] !== fb[k]).slice(0, 8).map((k) => (k in fa ? `${k}: ${fa[k]} → ${fb[k]}` : `${k}: ${fb[k]}`));
  if (a?.lines && b?.lines && Array.isArray(a.lines) && Array.isArray(b.lines)) {
    b.lines.forEach((l: any, i: number) => {
      const x = a.lines.find((q: any) => q.id === l.id) ?? a.lines[i];
      if (x && x.yarn_description !== l.yarn_description) out.push(`line ${l.line_no ?? i + 1} yarn: ${x.yarn_description} → ${l.yarn_description}`);
      if (x && x.fabric_description !== l.fabric_description) out.push(`line ${l.line_no ?? i + 1} fabric: ${x.fabric_description} → ${l.fabric_description}`);
    });
  }
  return out.join(' · ');
}

/* ─────────────────────────── route ─────────────────────────── */
export default function KnittingYarnIssueDcPage() {
  const { id } = useParams();
  if (!id) return <DcList />;
  return <DcEditor key={id} id={id === 'new' ? null : Number(id)} />;
}
