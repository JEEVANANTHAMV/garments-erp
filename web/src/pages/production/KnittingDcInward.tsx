import { Fragment, useEffect, useRef, useState } from 'react';
import { QuotationPicker, GateEntryPicker, type QuoteValue } from '../../components/ProcessPickers';
import { barcodeHtml } from '../../lib/printBarcode';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Truck, PackagePlus, Printer, Plus, Trash2, Save, X, Scale, Undo2 } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Modal, Input, Select, Textarea, LoadingBlock } from '../../components/ui';

/**
 * Knitting DC (yarn outward to the knitter) and grey fabric inward against it,
 * with the yarn-vs-fabric reconciliation for the program.
 *
 * Client review 27-Sep-2026: after a program is released the yarn goes out on
 * a DC, and the grey fabric comes back against that DC (our ref + their DC no)
 * into fabric roll stock. Screens are kept line-wise and simple on purpose.
 */

/** Program statuses from which yarn may go out to the knitter. */
export const KNIT_DC_READY = [
  'RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
  'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED',
];

const useLookup = (name: string) => useQuery({
  queryKey: ['lookups', name],
  queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${name}`)).data || [],
});

const useReconciliation = (programId: number | null) => useQuery({
  queryKey: ['knit-recon', programId],
  queryFn: async () => (await http.get<{ data: any }>(
    `/knitting-programs/${programId}/reconciliation`)).data,
  enabled: !!programId,
});

const invalidateKnitting = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ['knitting-programs', 'knitting-program', 'knit-recon', 'knit-dcs', 'knit-inwards', 'knit-yarn-returns', 'knit-dc-balance', 'knit-yarn-req']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
};

/* ─────────────────────────────────────────────────────────────────
   Reconciliation — yarn given vs grey fabric received
───────────────────────────────────────────────────────────────── */
export function KnittingReconciliation({ programId, compact = false }: { programId: number; compact?: boolean }) {
  const { data, isLoading } = useReconciliation(programId);
  if (isLoading || !data) return <LoadingBlock rows={3} />;
  const t = data.totals;

  const tiles: [string, string, string][] = [
    ['Yarn given', `${fmtDecimal(t.issued_kg, 3)} kg`, 'text-orange-700'],
    ['Grey fabric received', `${fmtDecimal(t.fabric_received_kg, 3)} kg`, 'text-emerald-700'],
    ['Process loss', `${fmtDecimal(t.loss_kg, 3)} kg · ${fmtDecimal(t.loss_pct, 2)}%`, 'text-rose-700'],
    ['Yarn returned', `${fmtDecimal(t.returned_kg ?? 0, 3)} kg`, 'text-sky-700'],
    ['Balance yarn at knitter', `${fmtDecimal(t.balance_yarn_kg, 3)} kg`, 'text-brand-700'],
    ['Cones given / returned / bal.',
      `${t.cones_issued} / ${t.cones_returned ?? 0} / ${t.cones_estimated ? '≈' : ''}${t.cones_balance}`, 'text-slate-800'],
    ['Rolls received', `${t.rolls_received}`, 'text-slate-800'],
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, value, tone]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
            <p className={`mt-0.5 text-[13px] font-bold tabular-nums ${tone}`}>{value}</p>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-slate-400">
        Yarn consumed {fmtDecimal(t.consumed_kg, 3)} kg = fabric {fmtDecimal(t.fabric_received_kg, 3)} +
        rejected {fmtDecimal(t.rejected_kg, 3)} + loss {fmtDecimal(t.loss_kg, 3)}.
        Balance = yarn given − yarn consumed − yarn returned. Cone balance marked ≈ is estimated from the KG
        still open. Required fabric {fmtDecimal(t.required_fabric_kg, 2)} kg.
      </p>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">#</th>
              <th className="th">Yarn</th>
              <th className="th">Colour</th>
              <th className="th text-right">Planned KG</th>
              <th className="th text-right">Given KG</th>
              <th className="th text-right">Consumed KG</th>
              <th className="th text-right">Returned KG</th>
              <th className="th text-right">Balance KG</th>
              <th className="th text-right">Cones given</th>
              <th className="th text-right">Cones ret.</th>
              <th className="th text-right">Cones bal.</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l: any) => (
              <tr key={l.program_yarn_id} className="border-t border-slate-100">
                <td className="td text-slate-500">{l.seq_no}</td>
                <td className="td font-medium">{l.yarn}</td>
                <td className="td">{l.colour || '—'}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(l.planned_kg, 3)}</td>
                <td className="td text-right tabular-nums text-orange-700 font-semibold">{fmtDecimal(l.issued_kg, 3)}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(l.consumed_kg, 3)}</td>
                <td className="td text-right tabular-nums text-sky-700">{fmtDecimal(l.returned_kg ?? 0, 3)}</td>
                <td className="td text-right tabular-nums font-semibold text-brand-700">{fmtDecimal(l.balance_kg, 3)}</td>
                <td className="td text-right tabular-nums">{l.cones_issued}</td>
                <td className="td text-right tabular-nums">{l.cones_returned ?? 0}</td>
                <td className="td text-right tabular-nums">{l.cones_estimated ? '≈' : ''}{l.cones_balance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!compact && data.dcs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">Knitting DC</th>
                <th className="th">Date</th>
                <th className="th text-right">Yarn given KG</th>
                <th className="th text-right">Cones</th>
                <th className="th text-right">Fabric in KG</th>
                <th className="th text-right">Yarn consumed KG</th>
                <th className="th text-right">Returned KG</th>
                <th className="th text-right">Balance KG</th>
              </tr>
            </thead>
            <tbody>
              {data.dcs.map((d: any) => (
                <tr key={d.dc_no} className="border-t border-slate-100">
                  <td className="td font-mono font-semibold text-brand-700">{d.dc_no}</td>
                  <td className="td text-slate-500">{fmtDate(d.dc_date)}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(d.issued_kg, 3)}</td>
                  <td className="td text-right tabular-nums">{d.cones}</td>
                  <td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(d.fabric_kg, 3)}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(d.consumed_kg, 3)}</td>
                  <td className="td text-right tabular-nums text-sky-700">{fmtDecimal(d.returned_kg ?? 0, 3)}</td>
                  <td className="td text-right tabular-nums font-semibold">{fmtDecimal(d.balance_kg, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Knitting DC — yarn outward (line-wise)
───────────────────────────────────────────────────────────────── */
export function KnittingDcModal({ programId, open, onClose, onPrint }: {
  programId: number | null; open: boolean; onClose: () => void; onPrint: (dcNo: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: warehouses = [] } = useLookup('warehouses');
  const { data: suppliers = [] } = useLookup('suppliers');
  // One knitting DC can carry several jobs (programs) to the same knitter
  const { data: allPrograms = [] } = useQuery({
    queryKey: ['knitting-programs', 'dc-ready'],
    queryFn: async () => ((await http.get<{ data: any[] }>('/knitting/programs?pageSize=300')).data ?? [])
      .filter((p: any) => ['RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED'].includes(p.status)),
    enabled: open,
  });
  const [h, setH] = useState<any>({});
  const [jobs, setJobs] = useState<DcJob[]>([]);
  const [addId, setAddId] = useState('');
  const [saving, setSaving] = useState(false);

  // KG of each lot already taken by the lines on this DC (so a second job does not pick the same KG)
  const usedKg = (js: DcJob[]) => {
    const m = new Map<string, number>();
    js.forEach((j) => j.lines.forEach((l) => { if (l.grn_line_id) m.set(l.grn_line_id, (m.get(l.grn_line_id) ?? 0) + (Number(l.issued_qty_kg) || 0)); }));
    return m;
  };
  const loadJob = async (pid: number, used: Map<string, number> = new Map()): Promise<DcJob> => {
    const prog = (await http.get<{ data: any }>(`/knitting/programs/${pid}`)).data;
    const qs = new URLSearchParams(prog.so_id ? { so_id: String(prog.so_id) } : { io_no: prog.io_no ?? '' });
    const lots: any[] = (await http.get<{ data: any[] }>(`/yarn-stock/job-lots?${qs}`)).data ?? [];
    // approved (posted) substitutions of the program: the substitute yarn may go out against the original line
    const subs: any[] = (await http.get<{ data: any[] }>(`/yarn-substitution-requests?program_id=${pid}&status=POSTED`)).data ?? [];
    const lines = (prog.yarns ?? []).filter((y: any) => y.yarn_id).map((y: any) => {
      const pending = Math.max(0, Number(y.planned_qty_kg) - Number(y.issued_qty_kg));
      const subYarns = subs.filter((x) => Number(x.program_yarn_id) === Number(y.id) && Number(x.qty_kg) > Number(x.issued_kg)).map((x) => Number(x.substitute_yarn_id));
      // job's own lots first (oldest first), then general stock; then lots of an approved substitute yarn
      const options = lots.filter((l) => Number(l.yarn_id) === Number(y.yarn_id)).sort((a, b) => Number(b.own_lot && !!b.holder_so_id) - Number(a.own_lot && !!a.holder_so_id))
        .concat(lots.filter((l) => subYarns.includes(Number(l.yarn_id))).map((l) => ({ ...l, substitute: true })));
      const left = (o: any) => o.available_kg - (used.get(String(o.grn_line_id)) ?? 0);
      const pick = options.find((o: any) => left(o) > 0.0005);
      const qty = pending && pick ? Math.min(pending, left(pick)) : 0;
      if (pick) used.set(String(pick.grn_line_id), (used.get(String(pick.grn_line_id)) ?? 0) + qty);
      return {
        program_yarn_id: y.id, yarn_id: y.yarn_id, yarn: `${y.yarn_code ?? ''} — ${y.yarn_name ?? ''}`, colour: y.colour, count: y.count_value, pending, options,
        grn_line_id: pick ? String(pick.grn_line_id) : '',
        issued_qty_kg: qty ? String(Math.round(qty * 1000) / 1000) : '', no_of_cones: '',
      };
    });
    return { program_id: pid, program_no: prog.program_no, io_no: prog.io_no, so_id: prog.so_id ?? null, quote: { quotation_id: '', quotation_line_id: '', rate_per_kg: '' }, style: prog.style_code, fabric: prog.fabric_name ?? prog.fabric_type, vendor_id: prog.vendor_id, lines };
  };

  useEffect(() => {
    if (!open || !programId) return;
    setH({ dc_date: today(), vendor_id: '', vehicle_no: '', warehouse_id: '', remarks: '', allow_override: false, override_reason: '' });
    setJobs([]);
    void loadJob(programId).then((j) => { setJobs([j]); setH((x: any) => ({ ...x, vendor_id: j.vendor_id ? String(j.vendor_id) : '' })); })
      .catch((e) => toast(e?.message || 'Could not load the program', 'error'));
  }, [open, programId]);

  const addJob = async () => {
    if (!addId) return;
    if (jobs.some((j) => String(j.program_id) === addId)) { toast('That job is already on the DC', 'warning'); return; }
    try { const j = await loadJob(Number(addId), usedKg(jobs)); setJobs((js) => [...js, j]); setAddId(''); } catch (e: any) { toast(e?.message || 'Could not load the program', 'error'); }
  };
  const setQuote = (ji: number, q: QuoteValue) => setJobs((js) => js.map((j, a) => (a === ji ? { ...j, quote: q } : j)));
  const setLine = (ji: number, li: number, patch: any) =>
    setJobs((js) => js.map((j, a) => (a !== ji ? j : { ...j, lines: j.lines.map((l, b) => (b === li ? { ...l, ...patch } : l)) })));
  const all = jobs.flatMap((j) => j.lines);
  const totalKg = all.reduce((n, l) => n + (Number(l.issued_qty_kg) || 0), 0);
  const totalCones = all.reduce((n, l) => n + (Number(l.no_of_cones) || 0), 0);

  const save = async () => {
    if (!h.warehouse_id) { toast('Select the store the yarn goes out from', 'error'); return; }
    if (!h.vendor_id) { toast('Select the knitting unit (supplier / vendor)', 'error'); return; }
    if (!(totalKg > 0)) { toast('Enter the KG to send on at least one line', 'error'); return; }
    const noLot = all.find((l) => Number(l.issued_qty_kg) > 0 && !l.grn_line_id);
    if (noLot && !h.allow_override) { toast(`${noLot.yarn}: pick the yarn lot (GRN) the KG comes from`, 'error'); return; }
    const noQuote = jobs.find((j) => j.lines.some((l) => Number(l.issued_qty_kg) > 0) && !j.quote.quotation_id);
    if (noQuote) { toast(`Job ${noQuote.io_no ?? noQuote.program_no}: pick its approved knitting quotation`, 'warning'); return; }
    setSaving(true);
    try {
      const r = await http.post<{ data: { dc_no: string } }>('/knitting-dcs', {
        dc_date: h.dc_date, vendor_id: Number(h.vendor_id), vehicle_no: h.vehicle_no || null, warehouse_id: Number(h.warehouse_id),
        allow_override: h.allow_override, override_reason: h.override_reason || null, remarks: h.remarks || null,
        // each job goes out on its own approved quotation / rate
        jobs: jobs.map((j) => ({ program_id: j.program_id,
          quotation_id: j.quote.quotation_id ? Number(j.quote.quotation_id) : null, quotation_line_id: j.quote.quotation_line_id ? Number(j.quote.quotation_line_id) : null,
          rate_per_kg: j.quote.rate_per_kg !== '' ? Number(j.quote.rate_per_kg) : null, lines: j.lines.filter((l) => Number(l.issued_qty_kg) > 0).map((l) => ({
          program_yarn_id: l.program_yarn_id, yarn_id: Number(l.options.find((o: any) => String(o.grn_line_id) === l.grn_line_id)?.yarn_id ?? l.yarn_id), grn_line_id: l.grn_line_id ? Number(l.grn_line_id) : null,
          issued_qty_kg: Number(l.issued_qty_kg), no_of_cones: Number(l.no_of_cones) || 0,
        })) })).filter((j) => j.lines.length),
      });
      toast(`Knitting DC ${r.data.dc_no} created for ${jobs.length} job(s)`);
      invalidateKnitting(qc);
      onClose();
      onPrint(r.data.dc_no);
    } catch (e: any) {
      toast(e?.message || 'Could not create the knitting DC', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="full"
      title={`Knitting DC — Yarn Outward${jobs.length ? ` · ${jobs.map((j) => j.program_no).join(', ')}` : ''}`}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-600"><b>{jobs.length}</b> job(s) · <b>{fmtDecimal(totalKg, 3)}</b> KG · {totalCones} cones</span>
        <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving} id="btn-save-knit-dc">
          <Truck size={14} /> {saving ? 'Saving…' : 'Save & Print DC'}
        </button>
      </>}>
      {!jobs.length ? <LoadingBlock rows={4} /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input label="DC Date" type="date" value={h.dc_date ?? ''} onChange={(e) => setH({ ...h, dc_date: e.target.value })} id="kdc-date" />
            <Select label="Knitting unit (Supplier / Vendor)" required value={h.vendor_id ?? ''} placeholder="— Select —"
              onChange={(e) => { setH({ ...h, vendor_id: e.target.value }); setJobs((js) => js.map((j) => ({ ...j, quote: { quotation_id: '', quotation_line_id: '', rate_per_kg: '' } }))); }} id="kdc-vendor">
              {suppliers.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
            <Select label="From Store" required value={h.warehouse_id ?? ''} placeholder="— Select —"
              onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} id="kdc-wh">
              {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
            <Input label="Vehicle No" value={h.vehicle_no ?? ''} onChange={(e) => setH({ ...h, vehicle_no: e.target.value })} id="kdc-vehicle" />
          </div>

          {jobs.map((j, ji) => (
            <div key={j.program_id} className="overflow-x-auto rounded-lg border border-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-sky-50 px-3 py-2 text-[12px]">
                <span className="font-semibold text-sky-900">Job {j.io_no ?? 'stock'} · Program {j.program_no}{j.style ? ` · Style ${j.style}` : ''}{j.fabric ? ` · ${j.fabric}` : ''}</span>
                {ji > 0 && <button className="text-slate-500 hover:text-red-600" onClick={() => setJobs((js) => js.filter((_, a) => a !== ji))}><Trash2 size={13} /></button>}
              </div>
              <div className="border-b border-slate-100 bg-white px-3 py-2">
                <QuotationPicker vendorId={h.vendor_id} material="YARN" process="Knitting" ioNo={j.io_no} soId={j.so_id} label={`Knitting quotation for job ${j.io_no ?? j.program_no}`}
                  value={j.quote} onChange={(q) => setQuote(ji, q)} idPrefix={`kdc-q${ji}`} />
              </div>
              <table className="w-full text-[12px]">
                <thead className="bg-slate-50"><tr>
                  <th className="th">Yarn</th><th className="th">Colour</th><th className="th text-right">To give KG</th>
                  <th className="th">Yarn lot (GRN / PO / supplier) — this job's yarn first</th><th className="th text-right">KG</th><th className="th text-right">Cones</th>
                </tr></thead>
                <tbody>
                  {!j.lines.length && <tr><td colSpan={6} className="td py-4 text-center text-slate-400">This program has no yarn lines with a yarn selected</td></tr>}
                  {j.lines.map((l, li) => {
                    const lot = l.options.find((o: any) => String(o.grn_line_id) === l.grn_line_id);
                    const over = lot && Number(l.issued_qty_kg) > lot.available_kg + 1e-6;
                    return (
                      <tr key={l.program_yarn_id} className="border-t border-slate-100">
                        <td className="td font-medium">{l.yarn}{l.count ? <span className="ml-1 text-slate-400">{l.count}</span> : null}</td>
                        <td className="td">{l.colour || '—'}</td>
                        <td className="td text-right tabular-nums text-slate-500">{fmtDecimal(l.pending, 3)}</td>
                        <td className="td">
                          <select className="input min-w-[340px] py-1 text-[11.5px]" value={l.grn_line_id} onChange={(e) => setLine(ji, li, { grn_line_id: e.target.value })} id={`kdc-lot-${ji}-${li}`}>
                            <option value="">{l.options.length ? '— pick lot —' : 'No stock for this job — transfer yarn to the job first'}</option>
                            {l.options.map((o: any) => (
                              <option key={`${o.grn_line_id}-${o.holder_so_id}`} value={o.grn_line_id}>
                                {o.substitute ? `[Approved substitute ${o.yarn_name}] ` : ''}{o.lot_no} · {o.grn_no}{o.po_no ? ` · PO ${o.po_no}` : ''}{o.supplier_name ? ` · ${o.supplier_name}` : ''} · {fmtDecimal(o.available_kg, 3)} KG ({o.holder_job})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="td"><input className={`input w-24 text-right ${over ? 'border-red-400 text-red-700' : ''}`} type="number" step="0.001"
                          value={l.issued_qty_kg} onChange={(e) => setLine(ji, li, { issued_qty_kg: e.target.value })} id={`kdc-kg-${ji}-${li}`} title={over ? 'More than the lot holds' : undefined} /></td>
                        <td className="td"><input className="input w-20 text-right" type="number" step="1"
                          value={l.no_of_cones} onChange={(e) => setLine(ji, li, { no_of_cones: e.target.value })} id={`kdc-cones-${ji}-${li}`} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

          <div className="flex flex-wrap items-end gap-2">
            <Select label="Add another job (program) to this DC" className="w-96" value={addId} placeholder="— Released program —" onChange={(e) => setAddId(e.target.value)}>
              {allPrograms.filter((p: any) => !jobs.some((j) => j.program_id === p.id)).map((p: any) => <option key={p.id} value={p.id}>{p.program_no} · {p.io_no ?? 'stock'}</option>)}
            </Select>
            <button className="btn-secondary" onClick={addJob} disabled={!addId}><Plus size={14} /> Add job</button>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <label className="flex items-center gap-2 text-[12px] text-slate-700">
              <input type="checkbox" checked={!!h.allow_override}
                onChange={(e) => setH({ ...h, allow_override: e.target.checked })} id="kdc-override" />
              Send beyond available stock (needs authorisation)
            </label>
            {h.allow_override && (
              <Input label="Override reason" required value={h.override_reason ?? ''} className="mt-2"
                onChange={(e) => setH({ ...h, override_reason: e.target.value })} id="kdc-reason" />
            )}
          </div>
          <Textarea label="Remarks" value={h.remarks ?? ''} onChange={(e) => setH({ ...h, remarks: e.target.value })} id="kdc-remarks" />
        </div>
      )}
    </Modal>
  );
}

interface DcJob {
  program_id: number; program_no: string; io_no: string | null; so_id: number | null; style: string | null; fabric: string | null; vendor_id: number | null;
  /** The job's own approved knitting quotation — rates vary a little job to job. */
  quote: QuoteValue;
  lines: { program_yarn_id: number; yarn_id: number; yarn: string; colour: string | null; count: string | null; pending: number; options: any[]; grn_line_id: string; issued_qty_kg: string; no_of_cones: string }[];
}

/* ─────────────────────────────────────────────────────────────────
   Printable knitting DC
───────────────────────────────────────────────────────────────── */
const PRINT_CSS = `
  .kdc { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #0f172a; }
  .kdc h1 { font-size: 18px; margin: 0; text-align: center; }
  .kdc .sub { text-align: center; color: #475569; font-size: 11px; margin: 2px 0 8px; }
  .kdc .title { text-align: center; font-weight: 700; font-size: 14px; letter-spacing: 1px;
    border-top: 2px solid #0f172a; border-bottom: 2px solid #0f172a; padding: 4px 0; margin-bottom: 10px; }
  .kdc .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 10px; }
  .kdc .grid div span { color: #64748b; display: inline-block; min-width: 110px; }
  .kdc table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .kdc th, .kdc td { border: 1px solid #94a3b8; padding: 4px 6px; text-align: left; }
  .kdc th { background: #f1f5f9; font-size: 11px; }
  .kdc td.n, .kdc th.n { text-align: right; }
  .kdc tfoot td { font-weight: 700; }
  .kdc .sign { display: flex; justify-content: space-between; margin-top: 48px; font-size: 11px; }
  .kdc .sign div { border-top: 1px solid #0f172a; padding-top: 4px; min-width: 160px; text-align: center; }
`;

export function KnittingDcPrint({ dcNo, onClose }: { dcNo: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: dc, isLoading } = useQuery({
    queryKey: ['knit-dc', dcNo],
    queryFn: async () => (await http.get<{ data: any }>(`/knitting-dcs/${encodeURIComponent(dcNo!)}`)).data,
    enabled: !!dcNo,
  });

  // Print just the DC sheet in its own window so the app behind it stays out.
  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w || !ref.current) return;
    w.document.write(`<!doctype html><html><head><title>${dcNo}</title><style>${PRINT_CSS}</style></head>` +
      `<body>${barcodeHtml(dcNo)}${ref.current.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const c = dc?.company ?? {};
  return (
    <Modal open={!!dcNo} onClose={onClose} size="lg" title={`Knitting DC ${dcNo ?? ''}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-primary" onClick={print} disabled={!dc} id="btn-print-knit-dc">
          <Printer size={14} /> Print
        </button>
      </>}>
      {isLoading || !dc ? <LoadingBlock rows={5} /> : (
        <div ref={ref}>
          <style>{PRINT_CSS}</style>
          <div className="kdc">
            <h1>{c.trade_name || c.legal_name || 'Company'}</h1>
            <p className="sub">
              {[c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', ')}
              {c.gstin ? ` · GSTIN ${c.gstin}` : ''}
            </p>
            <div className="title">DELIVERY CHALLAN — YARN FOR KNITTING (JOB WORK)</div>
            <div className="grid">
              <div><span>DC No</span><b>{dc.dc_no}</b></div>
              <div><span>DC Date</span>{fmtDate(dc.dc_date)}</div>
              <div><span>Supplier / Vendor</span><b>{dc.vendor_name ?? '—'}</b></div>
              <div><span>Vendor GSTIN</span>{dc.vendor_gstin ?? '—'}</div>
              <div><span>Program No</span><b>{dc.program_no}</b></div>
              <div><span>I/O (Job) No</span><b>{dc.io_no ?? '—'}</b></div>
              <div><span>Style</span>{dc.style_code ? `${dc.style_code} — ${dc.style_name ?? ''}` : '—'}</div>
              <div><span>Buyer PO</span>{dc.buyer_po_no ?? '—'}</div>
              <div><span>Fabric</span>{dc.fabric_name ?? '—'} {dc.part_name ? `(${dc.part_name})` : ''}</div>
              <div><span>GSM / Dia / Gauge</span>{dc.gsm ?? '—'} / {dc.dia ?? '—'} / {dc.gauge ?? '—'}</div>
              <div><span>Required fabric</span>{fmtDecimal(dc.required_qty_kg, 2)} kg</div>
              <div><span>Vehicle No</span>{dc.vehicle_no ?? '—'}</div>
              <div><span>From Store</span>{dc.warehouse_name ?? '—'}</div>
              {(dc.jobs?.length ?? 1) === 1 && dc.jobs?.[0]?.rate_per_kg != null && (
                <div><span>Knitting rate</span>₹{fmtDecimal(dc.jobs[0].rate_per_kg, 2)}/KG{dc.jobs[0].quotation_no ? ` (${dc.jobs[0].quotation_no})` : ''}</div>
              )}
            </div>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Yarn</th><th>Count</th><th>Colour</th><th>Lot No</th><th>Yarn PO</th>
                  <th className="n">Cones</th><th className="n">Qty (KG)</th>
                </tr>
              </thead>
              <tbody>
                {(dc.jobs ?? [{ program_no: dc.program_no, io_no: dc.io_no, lines: dc.lines }]).map((jb: any) => (
                  <Fragment key={jb.program_no}>
                    {(dc.jobs?.length ?? 1) > 1 && (
                      <tr><td colSpan={8} style={{ background: '#e8f0f7', fontWeight: 700 }}>
                        Job {jb.io_no ?? 'stock'} · Program {jb.program_no}{jb.style_code ? ` · Style ${jb.style_code}` : ''}{jb.fabric_name ? ` · ${jb.fabric_name}` : ''} — {fmtDecimal(jb.total_kg, 3)} KG
                        {jb.rate_per_kg != null ? ` · Knitting rate ₹${fmtDecimal(jb.rate_per_kg, 2)}/KG${jb.quotation_no ? ` (${jb.quotation_no})` : ''}` : ''}
                      </td></tr>
                    )}
                    {jb.lines.map((l: any, i: number) => (
                      <tr key={l.id}>
                        <td>{i + 1}</td>
                        <td>{l.yarn_code} — {l.yarn_name}</td>
                        <td>{l.count_value || l.yarn_count || '—'}</td>
                        <td>{l.colour || '—'}</td>
                        <td>{l.lot_no || '—'}{l.grn_no ? ` (${l.grn_no})` : ''}</td>
                        <td>{l.yarn_po_no || '—'}</td>
                        <td className="n">{l.no_of_cones}</td>
                        <td className="n">{fmtDecimal(l.issued_qty_kg, 3)}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={6}>Total</td>
                  <td className="n">{dc.total_cones}</td>
                  <td className="n">{fmtDecimal(dc.total_kg, 3)}</td>
                </tr>
              </tfoot>
            </table>
            {dc.remarks && <p style={{ marginTop: 8 }}><b>Remarks:</b> {dc.remarks}</p>}
            <p style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
              Sent for knitting on job-work basis, not for sale. Please return grey fabric quoting this DC no
              and your DC no.
            </p>
            <div className="sign">
              <div>Prepared by</div><div>Received by (Knitter)</div><div>Authorised signatory</div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Grey fabric inward — against the knitting DC (roll-wise)
───────────────────────────────────────────────────────────────── */
const newRoll = (p?: any) => ({ roll_no: '', weight_kg: '', dia: p?.dia ?? '', gsm: p?.gsm ?? '', meters: '' });

export function KnittingInwardModal({ programId, open, onClose }: {
  programId: number | null; open: boolean; onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: warehouses = [] } = useLookup('warehouses');
  // only the job's fabrics (program / job programs / job BOM-CAD) — no wrong fabric can be picked
  const { data: allFabrics = [] } = useLookup('fabrics');
  const { data: jobFabrics, isFetched: fabricsFetched } = useQuery({
    queryKey: ['knit-program-fabrics', programId],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-programs/${programId}/fabrics`)).data ?? [],
    enabled: open && !!programId,
  });
  // no fabric on the program / job BOM yet → every fabric (the server then does not restrict either)
  const noJobFabric = fabricsFetched && !(jobFabrics ?? []).length;
  const fabrics: any[] = noJobFabric ? allFabrics.map((f: any) => ({ id: f.id, fabric_code: f.code, fabric_name: f.label, source: 'all fabrics' })) : (jobFabrics ?? []);
  const { data: recon } = useReconciliation(open ? programId : null);
  const [h, setH] = useState<any>({});
  const [rolls, setRolls] = useState<any[]>([newRoll()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !recon) return;
    const p = recon.program;
    const openDc = recon.dcs.find((d: any) => d.balance_kg > 0 && d.status !== 'CLOSED');
    setH({
      dc_nos: openDc ? [openDc.dc_no] : [], receipt_type: 'PARTIAL', gate_inward_id: '', party_dc_no: '', receipt_date: today(), vehicle_no: '',
      warehouse_id: '', fabric_id: p.fabric_id ?? '', lot_no: '', yarn_consumed_kg: '',
      rejected_kg: '', remarks: '',
    });
    setRolls([newRoll(p)]);
    // Only reset when the dialog opens for a program, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recon?.program?.id]);

  const setRoll = (i: number, patch: any) => setRolls((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fabricKg = rolls.reduce((n, r) => n + (Number(r.weight_kg) || 0), 0);
  const rejected = Number(h.rejected_kg) || 0;
  const consumed = h.yarn_consumed_kg === '' || h.yarn_consumed_kg == null
    ? fabricKg + rejected : Number(h.yarn_consumed_kg);
  const loss = Math.max(0, consumed - fabricKg - rejected);
  const picked = (recon?.dcs ?? []).filter((d: any) => (h.dc_nos ?? []).includes(d.dc_no));
  const openKg = picked.length ? picked.reduce((a: number, d: any) => a + Math.max(0, Number(d.issued_kg) - Number(d.consumed_kg) - Number(d.returned_kg ?? 0)), 0)
    : recon ? Number(recon.totals.issued_kg) - Number(recon.totals.consumed_kg) - Number(recon.totals.returned_kg ?? 0) : 0;
  const toggleDc = (no: string) => setH((x: any) => ({ ...x, dc_nos: (x.dc_nos ?? []).includes(no) ? x.dc_nos.filter((d: string) => d !== no) : [...(x.dc_nos ?? []), no] }));

  const save = async () => {
    if (!h.party_dc_no) { toast('Enter the knitter DC number', 'error'); return; }
    if (!h.warehouse_id) { toast('Select the store receiving the fabric', 'error'); return; }
    const good = rolls.filter((r) => Number(r.weight_kg) > 0);
    if (!good.length) { toast('Enter the KG of at least one roll', 'error'); return; }
    setSaving(true);
    try {
      const r = await http.post<{ data: any }>('/knitting-inwards', {
        program_id: programId, dc_nos: h.dc_nos ?? [], receipt_type: h.receipt_type, gate_inward_id: h.gate_inward_id ? Number(h.gate_inward_id) : null, party_dc_no: h.party_dc_no,
        receipt_date: h.receipt_date, vehicle_no: h.vehicle_no || null,
        warehouse_id: Number(h.warehouse_id), fabric_id: h.fabric_id ? Number(h.fabric_id) : null,
        lot_no: h.lot_no || null,
        yarn_consumed_kg: h.yarn_consumed_kg === '' ? null : Number(h.yarn_consumed_kg),
        rejected_kg: rejected, remarks: h.remarks || null,
        rolls: good.map((x) => ({
          roll_no: x.roll_no || null, weight_kg: Number(x.weight_kg),
          meters: x.meters === '' ? null : Number(x.meters),
          gsm: x.gsm === '' || Number.isNaN(Number.parseInt(x.gsm, 10)) ? null : Number.parseInt(x.gsm, 10),
          dia: x.dia || null,
        })),
      });
      toast(`Grey fabric inward ${r.data.receipt_no} saved — ${r.data.rolls.length} roll(s) in roll stock${r.data.receipt_type === 'FINAL' ? ` · DC ${(h.dc_nos ?? []).join(', ')} closed (final receipt)` : ' · partial — more to come'}`);
      invalidateKnitting(qc);
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not save the inward', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="xl"
      title={`Grey Fabric Inward — against Knitting DC${recon ? ` · ${recon.program.program_no}` : ''}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving} id="btn-save-knit-inward">
          <Save size={14} /> {saving ? 'Saving…' : 'Save Inward'}
        </button>
      </>}>
      {!recon ? <LoadingBlock rows={4} /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-[12px] sm:grid-cols-4">
            <Info label="Program" value={recon.program.program_no} />
            <Info label="I/O (Job) No" value={recon.program.io_no ?? '—'} />
            <Info label="Style" value={recon.program.style_code ?? '—'} />
            <Info label="Knitter" value={recon.program.vendor_name ?? '—'} />
          </div>

          <KnittingReconciliation programId={recon.program.id} compact />

          <div className="rounded-lg border border-slate-200 p-3">
            <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Our knitting DCs on this GRN (one GRN may cover several DCs)</p>
            <div className="flex flex-wrap gap-2">
              {recon.dcs.map((d: any) => {
                const closed = d.status === 'CLOSED';
                const on = (h.dc_nos ?? []).includes(d.dc_no);
                return (
                  <label key={d.dc_no} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] ${closed ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400' : on ? 'border-brand-400 bg-brand-50' : 'border-slate-200'}`}>
                    <input type="checkbox" disabled={closed} checked={on} onChange={() => toggleDc(d.dc_no)} id={`kin-dc-${d.dc_no}`} />
                    <span className="font-mono font-semibold">{d.dc_no}</span><span>{fmtDate(d.dc_date)}</span>
                    <span>given {fmtDecimal(d.issued_kg, 3)} · bal <b>{fmtDecimal(d.balance_kg, 3)}</b> kg</span>
                    <span className={`rounded px-1 text-[10px] font-bold ${closed ? 'bg-slate-200' : d.status === 'PARTIALLY_RECEIVED' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>{closed ? 'CLOSED' : d.status === 'PARTIALLY_RECEIVED' ? 'PART RECEIVED' : 'OPEN'}</span>
                  </label>
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[12px]">
              <span className="font-semibold text-slate-700">This receipt is:</span>
              <label className="flex items-center gap-1.5"><input type="radio" name="kin-type" checked={h.receipt_type === 'PARTIAL'} onChange={() => setH({ ...h, receipt_type: 'PARTIAL' })} id="kin-partial" /> Partial — more fabric to come on these DCs</label>
              <label className="flex items-center gap-1.5"><input type="radio" name="kin-type" checked={h.receipt_type === 'FINAL'} onChange={() => setH({ ...h, receipt_type: 'FINAL' })} id="kin-final" /> Final — last receipt, close the DC(s)</label>
              {h.receipt_type === 'FINAL' && <span className="text-amber-700">Yarn left with the knitter after this ({fmtDecimal(Math.max(0, openKg - consumed), 3)} kg) shows as "to be returned".</span>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2"><GateEntryPicker partyId={recon.program.vendor_id} value={h.gate_inward_id ?? ''} idPrefix="kin"
              onChange={(v) => setH((x: any) => ({ ...x, gate_inward_id: v }))}
              onPick={(g) => setH((x: any) => ({ ...x, gate_inward_id: String(g.id), vehicle_no: x.vehicle_no || g.vehicle_no || '', party_dc_no: x.party_dc_no || g.supplier_dc_no || '' }))} /></div>
            <Input label="Knitter DC No" required value={h.party_dc_no ?? ''}
              onChange={(e) => setH({ ...h, party_dc_no: e.target.value })} id="kin-party-dc" />
            <Input label="Inward Date" type="date" value={h.receipt_date ?? ''}
              onChange={(e) => setH({ ...h, receipt_date: e.target.value })} id="kin-date" />
            <Input label="Vehicle No" value={h.vehicle_no ?? ''}
              onChange={(e) => setH({ ...h, vehicle_no: e.target.value })} id="kin-vehicle" />
            <Select label="Receiving Store" required value={h.warehouse_id ?? ''} placeholder="— Select —"
              onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} id="kin-wh">
              {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
            <Select label="Grey Fabric (this job's)" required value={h.fabric_id ?? ''} placeholder={noJobFabric ? '— Select (no fabric on the program / BOM) —' : '— Select —'}
              onChange={(e) => setH({ ...h, fabric_id: e.target.value })} id="kin-fabric">
              {fabrics.map((f: any) => <option key={f.id} value={f.id}>{f.fabric_code ? `${f.fabric_code} — ` : ''}{f.fabric_name} ({f.source})</option>)}
            </Select>
            <Input label="Lot No" value={h.lot_no ?? ''} placeholder="Auto if blank"
              onChange={(e) => setH({ ...h, lot_no: e.target.value })} id="kin-lot" />
            <Input label="Rejected KG" type="number" step="0.001" value={h.rejected_kg ?? ''}
              onChange={(e) => setH({ ...h, rejected_kg: e.target.value })} id="kin-rejected" />
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Roll No</th>
                  <th className="th text-right">KG</th>
                  <th className="th">Dia</th>
                  <th className="th">GSM</th>
                  <th className="th text-right">Meters</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {rolls.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="td text-slate-500">{i + 1}</td>
                    <td className="td"><input className="input w-32" value={r.roll_no} placeholder="Auto"
                      onChange={(e) => setRoll(i, { roll_no: e.target.value })} id={`kin-roll-${i}`} /></td>
                    <td className="td"><input className="input w-24 text-right" type="number" step="0.001"
                      value={r.weight_kg} onChange={(e) => setRoll(i, { weight_kg: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && i === rolls.length - 1) setRolls((rs) => [...rs, newRoll(r)]); }}
                      id={`kin-kg-${i}`} /></td>
                    <td className="td"><input className="input w-20" value={r.dia}
                      onChange={(e) => setRoll(i, { dia: e.target.value })} /></td>
                    <td className="td"><input className="input w-20" value={r.gsm}
                      onChange={(e) => setRoll(i, { gsm: e.target.value })} /></td>
                    <td className="td"><input className="input w-24 text-right" type="number" step="0.01"
                      value={r.meters} onChange={(e) => setRoll(i, { meters: e.target.value })} /></td>
                    <td className="td">
                      {rolls.length > 1 && (
                        <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          onClick={() => setRolls((rs) => rs.filter((_, j) => j !== i))} title="Remove roll">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={2} className="td font-bold">{rolls.filter((r) => Number(r.weight_kg) > 0).length} roll(s)</td>
                  <td className="td text-right font-bold tabular-nums">{fmtDecimal(fabricKg, 3)}</td>
                  <td colSpan={4} className="td">
                    <button className="btn-secondary btn-sm" onClick={() => setRolls((rs) => [...rs, newRoll(rs[rs.length - 1])])}
                      id="btn-add-inward-roll">
                      <Plus size={13} /> Add roll
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input label="Yarn consumed KG (knitter)" type="number" step="0.001" value={h.yarn_consumed_kg ?? ''}
              placeholder={fmtDecimal(fabricKg + rejected, 3)}
              onChange={(e) => setH({ ...h, yarn_consumed_kg: e.target.value })} id="kin-consumed" />
            <div className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]">
              <Scale size={15} className="text-slate-400" />
              <span>This inward: fabric <b>{fmtDecimal(fabricKg, 3)}</b> + rejected <b>{fmtDecimal(rejected, 3)}</b> + loss <b className="text-rose-700">{fmtDecimal(loss, 3)}</b>
                {' '}({consumed > 0 ? fmtDecimal((loss / consumed) * 100, 2) : '0.00'}%) = yarn <b>{fmtDecimal(consumed, 3)}</b> kg.</span>
              <span className={`ml-auto font-semibold ${consumed > openKg + 1e-9 ? 'text-red-600' : 'text-brand-700'}`}>
                Balance after: {fmtDecimal(openKg - consumed, 3)} kg
              </span>
            </div>
          </div>
          <Textarea label="Remarks" value={h.remarks ?? ''}
            onChange={(e) => setH({ ...h, remarks: e.target.value })} id="kin-remarks" />
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Unused yarn return — from the knitter, against one knitting DC
───────────────────────────────────────────────────────────────── */
export function KnittingYarnReturnModal({ dcNo, onClose, onPrint }: {
  dcNo: string | null; onClose: () => void; onPrint: (returnNo: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const open = !!dcNo;
  const { data: warehouses = [] } = useLookup('warehouses');
  const { data: bal } = useQuery({
    queryKey: ['knit-dc-balance', dcNo],
    queryFn: async () => (await http.get<{ data: any }>(
      `/knitting-dcs/${encodeURIComponent(dcNo!)}/yarn-returns`)).data,
    enabled: open,
  });
  const [h, setH] = useState<any>({});
  const [lines, setLines] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !bal) return;
    setH({
      return_date: today(), party_dc_no: '', vehicle_no: '', gate_inward_id: '',
      warehouse_id: bal.warehouse_id ? String(bal.warehouse_id) : '', remarks: '',
    });
    setLines(bal.lines.map((l: any) => ({ ...l, return_kg: '', no_of_cones: '' })));
    // Reset only when the dialog opens for a DC, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bal?.dc_no]);

  const setLine = (i: number, patch: any) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const totalKg = lines.reduce((n, l) => n + (Number(l.return_kg) || 0), 0);
  const totalCones = lines.reduce((n, l) => n + (Number(l.no_of_cones) || 0), 0);
  const over = lines.some((l) => (Number(l.return_kg) || 0) > Number(l.balance_kg) + 1e-9);

  const save = async () => {
    if (!h.party_dc_no) { toast('Enter the knitter return DC number', 'error'); return; }
    if (!h.warehouse_id) { toast('Select the store receiving the yarn', 'error'); return; }
    if (!(totalKg > 0)) { toast('Enter the KG returned on at least one line', 'error'); return; }
    if (over) { toast('A line returns more than is still with the knitter', 'error'); return; }
    setSaving(true);
    try {
      const r = await http.post<{ data: { return_no: string } }>(
        `/knitting-dcs/${encodeURIComponent(dcNo!)}/yarn-returns`, {
          return_date: h.return_date, party_dc_no: h.party_dc_no, vehicle_no: h.vehicle_no || null,
          warehouse_id: Number(h.warehouse_id), remarks: h.remarks || null, gate_inward_id: h.gate_inward_id ? Number(h.gate_inward_id) : null,
          lines: lines.filter((l) => Number(l.return_kg) > 0).map((l) => ({
            yarn_id: l.yarn_id, lot_no: l.lot_no || null,
            return_kg: Number(l.return_kg), no_of_cones: Number(l.no_of_cones) || 0,
          })),
        });
      toast(`Yarn return ${r.data.return_no} saved — yarn is back in stock`);
      invalidateKnitting(qc);
      onClose();
      onPrint(r.data.return_no);
    } catch (e: any) {
      toast(e?.message || 'Could not save the yarn return', 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="xl" title={`Unused Yarn Return — against Knitting DC ${dcNo ?? ''}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving || over} id="btn-save-knit-yarn-return">
          <Undo2 size={14} /> {saving ? 'Saving…' : 'Save Return'}
        </button>
      </>}>
      {!bal ? <LoadingBlock rows={4} /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3 text-[12px] sm:grid-cols-4">
            <Info label="Knitting DC" value={`${bal.dc_no} · ${fmtDate(bal.dc_date)}`} />
            <Info label="Yarn given" value={`${fmtDecimal(bal.issued_kg, 3)} kg`} />
            <Info label="Consumed / returned" value={`${fmtDecimal(bal.consumed_kg, 3)} / ${fmtDecimal(bal.returned_kg, 3)} kg`} />
            <Info label="Still with knitter" value={`${fmtDecimal(bal.balance_kg, 3)} kg`} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Input label="Return Date" type="date" value={h.return_date ?? ''}
              onChange={(e) => setH({ ...h, return_date: e.target.value })} id="kyr-date" />
            <Input label="Knitter Return DC No" required value={h.party_dc_no ?? ''}
              onChange={(e) => setH({ ...h, party_dc_no: e.target.value })} id="kyr-party-dc" />
            <Input label="Vehicle No" value={h.vehicle_no ?? ''}
              onChange={(e) => setH({ ...h, vehicle_no: e.target.value })} id="kyr-vehicle" />
            <Select label="Receiving Store" required value={h.warehouse_id ?? ''} placeholder="— Select —"
              onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} id="kyr-wh">
              {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </Select>
            <div className="col-span-2"><GateEntryPicker partyId={bal.vendor_id} value={h.gate_inward_id ?? ''} idPrefix="kyr"
              onChange={(v) => setH((x: any) => ({ ...x, gate_inward_id: v }))}
              onPick={(g) => setH((x: any) => ({ ...x, gate_inward_id: String(g.id), vehicle_no: x.vehicle_no || g.vehicle_no || '', party_dc_no: x.party_dc_no || g.supplier_dc_no || '' }))} /></div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Yarn</th>
                  <th className="th">Colour</th>
                  <th className="th">Lot No</th>
                  <th className="th text-right">Given KG</th>
                  <th className="th text-right">Consumed KG</th>
                  <th className="th text-right">Returned KG</th>
                  <th className="th text-right">With knitter</th>
                  <th className="th text-right">Return KG</th>
                  <th className="th text-right">Cones</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const bad = (Number(l.return_kg) || 0) > Number(l.balance_kg) + 1e-9;
                  return (
                    <tr key={l.key} className="border-t border-slate-100">
                      <td className="td font-medium">{l.yarn}</td>
                      <td className="td">{l.colour || '—'}</td>
                      <td className="td font-mono">{l.lot_no || '—'}</td>
                      <td className="td text-right tabular-nums">{fmtDecimal(l.issued_kg, 3)}</td>
                      <td className="td text-right tabular-nums">{fmtDecimal(l.consumed_kg, 3)}</td>
                      <td className="td text-right tabular-nums">{fmtDecimal(l.returned_kg, 3)}</td>
                      <td className="td text-right tabular-nums font-semibold text-brand-700">{fmtDecimal(l.balance_kg, 3)}</td>
                      <td className="td"><input className={`input w-24 text-right ${bad ? 'border-red-400' : ''}`}
                        type="number" step="0.001" min="0" value={l.return_kg} disabled={!(Number(l.balance_kg) > 0)}
                        onChange={(e) => setLine(i, { return_kg: e.target.value })} id={`kyr-kg-${i}`} /></td>
                      <td className="td"><input className="input w-20 text-right" type="number" step="1" min="0"
                        value={l.no_of_cones} placeholder={l.cones_issued ? `≤${l.cones_not_returned}` : ''}
                        onChange={(e) => setLine(i, { no_of_cones: e.target.value })} id={`kyr-cones-${i}`} /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={7} className="td font-bold">Total</td>
                  <td className="td text-right font-bold tabular-nums">{fmtDecimal(totalKg, 3)}</td>
                  <td className="td text-right font-bold tabular-nums">{totalCones}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-[10.5px] text-slate-400">
            Consumed is the DC's grey-inward yarn spread over its lines by KG given. Returned yarn goes back into
            the same yarn and lot in the receiving store and can be issued again.
          </p>
          <Textarea label="Remarks" value={h.remarks ?? ''}
            onChange={(e) => setH({ ...h, remarks: e.target.value })} id="kyr-remarks" />
        </div>
      )}
    </Modal>
  );
}

/** Printable yarn return note — same sheet layout as the knitting DC. */
export function KnittingYarnReturnPrint({ returnNo, onClose }: { returnNo: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { data: rt, isLoading } = useQuery({
    queryKey: ['knit-yarn-return', returnNo],
    queryFn: async () => (await http.get<{ data: any }>(
      `/knitting-yarn-returns/${encodeURIComponent(returnNo!)}`)).data,
    enabled: !!returnNo,
  });
  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w || !ref.current) return;
    w.document.write(`<!doctype html><html><head><title>${returnNo}</title><style>${PRINT_CSS}</style></head>` +
      `<body>${barcodeHtml(returnNo, 'Return note')}${ref.current.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };
  const c = rt?.company ?? {};
  return (
    <Modal open={!!returnNo} onClose={onClose} size="lg" title={`Yarn Return ${returnNo ?? ''}`}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-primary" onClick={print} disabled={!rt} id="btn-print-knit-yarn-return">
          <Printer size={14} /> Print
        </button>
      </>}>
      {isLoading || !rt ? <LoadingBlock rows={5} /> : (
        <div ref={ref}>
          <style>{PRINT_CSS}</style>
          <div className="kdc">
            <h1>{c.trade_name || c.legal_name || 'Company'}</h1>
            <p className="sub">
              {[c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', ')}
              {c.gstin ? ` · GSTIN ${c.gstin}` : ''}
            </p>
            <div className="title">YARN RETURN NOTE — UNUSED YARN FROM KNITTER</div>
            <div className="grid">
              <div><span>Return No</span><b>{rt.return_no}</b></div>
              <div><span>Return Date</span>{fmtDate(rt.return_date)}</div>
              <div><span>From (Knitter)</span><b>{rt.vendor_name ?? '—'}</b></div>
              <div><span>Knitter DC No</span><b>{rt.party_dc_no ?? '—'}</b></div>
              <div><span>Against our DC</span><b>{rt.dc_no}</b></div>
              <div><span>Program No</span>{rt.program_no}</div>
              <div><span>I/O (Job) No</span><b>{rt.io_no ?? '—'}</b></div>
              <div><span>Style</span>{rt.style_code ? `${rt.style_code} — ${rt.style_name ?? ''}` : '—'}</div>
              <div><span>Vehicle No</span>{rt.vehicle_no ?? '—'}</div>
              <div><span>Received into</span>{rt.warehouse_name ?? '—'}</div>
            </div>
            <table>
              <thead>
                <tr><th>#</th><th>Yarn</th><th>Colour</th><th>Lot No</th><th className="n">Cones</th><th className="n">Qty (KG)</th></tr>
              </thead>
              <tbody>
                {rt.lines.map((l: any, i: number) => (
                  <tr key={l.id}>
                    <td>{i + 1}</td>
                    <td>{l.yarn_code} — {l.yarn_name}</td>
                    <td>{l.colour || '—'}</td>
                    <td>{l.lot_no || '—'}</td>
                    <td className="n">{l.no_of_cones}</td>
                    <td className="n">{fmtDecimal(l.return_kg, 3)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="n">{rt.total_cones}</td>
                  <td className="n">{fmtDecimal(rt.total_kg, 3)}</td>
                </tr>
              </tfoot>
            </table>
            {rt.remarks && <p style={{ marginTop: 8 }}><b>Remarks:</b> {rt.remarks}</p>}
            <div className="sign">
              <div>Delivered by (Knitter)</div><div>Received by (Store)</div><div>Authorised signatory</div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Detail tab — DCs, inwards and reconciliation for one program
───────────────────────────────────────────────────────────────── */
export function KnittingDcInwardTab({ prog }: { prog: any }) {
  const [dcOpen, setDcOpen] = useState(false);
  const [inOpen, setInOpen] = useState(false);
  const [printDc, setPrintDc] = useState<string | null>(null);
  const [returnDc, setReturnDc] = useState<string | null>(null);
  const [printReturn, setPrintReturn] = useState<string | null>(null);
  const ready = KNIT_DC_READY.includes(prog.status);
  const toast = useToast();
  const qc = useQueryClient();
  /** Cancel a yarn return posted by mistake (stock reversed; refused if the yarn was issued again). */
  const cancelReturn = async (r: any) => {
    const reason = window.prompt(`Cancel yarn return ${r.return_no}? Reason:`);
    if (!reason || reason.trim().length < 3) return;
    try {
      await http.post(`/knitting-yarn-returns/${encodeURIComponent(r.return_no)}/cancel`, { reason: reason.trim() });
      toast(`Yarn return ${r.return_no} cancelled — yarn counts as with the knitter again`);
      invalidateKnitting(qc);
    } catch (e: any) { toast(e?.message || 'Cancel failed', 'error'); }
  };

  const closeDc = async (d: any) => {
    const reason = window.prompt(`Close DC ${d.dc_no}${Number(d.job_count) > 1 ? ` for job ${prog.io_no ?? prog.program_no} (other jobs on the DC stay open)` : ''}? Reason:`);
    if (!reason || reason.trim().length < 3) return;
    const writeOff = Number(d.balance_yarn_kg) > 0 && window.confirm(`${fmtDecimal(d.balance_yarn_kg, 3)} kg yarn is still with the knitter. OK = write it off as process loss; Cancel = keep it as "to be returned".`);
    try {
      const r = await http.post<{ message: string }>(`/knitting-dcs/${encodeURIComponent(d.dc_no)}/close`, { reason: reason.trim(), write_off: writeOff, program_id: prog.id });
      toast((r as any).message ?? `DC ${d.dc_no} closed`); invalidateKnitting(qc);
    } catch (e: any) { toast(e?.message || 'Close failed', 'error'); }
  };
  const { data: reqs = [] } = useQuery({
    queryKey: ['knit-yarn-req', prog.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-programs/${prog.id}/yarn-requirements`)).data || [],
  });
  const { data: dcs = [] } = useQuery({
    queryKey: ['knit-dcs', prog.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-dcs?program_id=${prog.id}`)).data || [],
  });
  const { data: inwards = [] } = useQuery({
    queryKey: ['knit-inwards', prog.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-inwards?program_id=${prog.id}`)).data || [],
  });
  const { data: yarnReturns = [] } = useQuery({
    queryKey: ['knit-yarn-returns', prog.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-yarn-returns?program_id=${prog.id}`)).data || [],
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-slate-500">
          {ready ? 'Give yarn to the knitter on a DC, then receive grey fabric against it.'
            : 'Release the program to give the knitting DC.'}
        </p>
        <div className="flex gap-2">
          <button className="btn-secondary btn-sm" disabled={!ready} onClick={() => setDcOpen(true)} id="btn-detail-knit-dc">
            <Truck size={13} /> Knitting DC (yarn outward)
          </button>
          <button className="btn-secondary btn-sm" disabled={!dcs.length} onClick={() => setInOpen(true)} id="btn-detail-knit-inward">
            <PackagePlus size={13} /> Grey fabric inward
          </button>
        </div>
      </div>

      <KnittingReconciliation programId={prog.id} />

      {reqs.length > 0 && (
        <div>
          <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Yarn requirement — required vs issued, transfer in, approved substitution</h5>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50"><tr>{['Yarn', 'Required KG', 'Issued KG', 'Transfer in (job)', 'Substitute (approved)', 'Substitute issued', 'Pending approval', 'Pending KG'].map((x) => <th key={x} className={`th ${x === 'Yarn' ? '' : 'text-right'}`}>{x}</th>)}</tr></thead>
              <tbody>{reqs.map((r: any) => (
                <tr key={r.program_yarn_id} className="border-t border-slate-100">
                  <td className="td font-medium">{r.yarn_name}{r.substitute_yarns ? <span className="ml-1 text-[10.5px] text-purple-700">sub: {r.substitute_yarns}</span> : null}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.required_kg, 3)}</td><td className="td text-right tabular-nums">{fmtDecimal(r.issued_kg, 3)}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.transfer_in_kg, 3)}</td>
                  <td className="td text-right tabular-nums text-purple-700">{fmtDecimal(r.substitute_kg, 3)}{Number(r.substitute_eq_kg) !== Number(r.substitute_kg) ? <span className="block text-[10px] text-slate-400">= {fmtDecimal(r.substitute_eq_kg, 3)} req.</span> : null}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.substitute_issued_kg, 3)}</td>
                  <td className="td text-right tabular-nums text-amber-700">{fmtDecimal(r.pending_approval_kg, 3)}</td>
                  <td className={`td text-right tabular-nums font-semibold ${Number(r.pending_kg) > 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{fmtDecimal(r.pending_kg, 3)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Short of a yarn? Raise a job transfer (Inventory → Job Stock Transfer) or a yarn substitution (Production → Yarn Substitution) — both need approval; the original requirement is never changed.</p>
        </div>
      )}

      <div>
        <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Knitting DCs</h5>
        {dcs.length === 0 ? <p className="py-3 text-center text-[12px] text-slate-400">No knitting DC given yet</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">DC No</th><th className="th">Date</th><th className="th">Knitter</th>
                  <th className="th">Vehicle</th><th className="th text-right">Lines</th>
                  <th className="th text-right">KG</th><th className="th text-right">Cones</th>
                  <th className="th text-right">Fabric in</th><th className="th text-right">Returned</th>
                  <th className="th text-right">Balance</th><th className="th">Status</th><th className="th">Rate</th><th className="th" />
                </tr>
              </thead>
              <tbody>
                {dcs.map((d: any) => (
                  <tr key={d.dc_no} className="border-t border-slate-100">
                    <td className="td font-mono font-semibold text-brand-700">{d.dc_no}</td>
                    <td className="td text-slate-500">{fmtDate(d.dc_date)}</td>
                    <td className="td">{d.vendor_name ?? '—'}</td>
                    <td className="td">{d.vehicle_no ?? '—'}</td>
                    <td className="td text-right">{d.line_count}</td>
                    <td className="td text-right tabular-nums font-semibold">{fmtDecimal(d.total_kg, 3)}</td>
                    <td className="td text-right tabular-nums">{d.total_cones}</td>
                    <td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(d.fabric_received_kg, 3)}</td>
                    <td className="td text-right tabular-nums text-sky-700">{fmtDecimal(d.yarn_returned_kg ?? 0, 3)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(d.balance_yarn_kg, 3)}</td>
                    <td className="td whitespace-nowrap">
                      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${d.status === 'CLOSED' ? 'bg-slate-200 text-slate-700' : d.status === 'PARTIALLY_RECEIVED' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800'}`}>
                        {d.status === 'CLOSED' ? (d.close_type === 'SHORT_CLOSE' ? 'Closed (short)' : 'Fully received') : d.status === 'PARTIALLY_RECEIVED' ? 'Partially received' : 'Open'}</span>
                      {Number(d.job_count) > 1 && d.dc_status_all && d.dc_status_all !== d.dc_status && <span className="block text-[10px] text-slate-400">DC: {String(d.dc_status_all).toLowerCase().replace('_', ' ')} (other jobs)</span>}
                      {Number(d.yarn_to_return_kg) > 0 && <span className="ml-1 text-[10.5px] font-semibold text-rose-700">{fmtDecimal(d.yarn_to_return_kg, 3)} kg yarn to return</span>}
                    </td>
                    <td className="td whitespace-nowrap text-[11px]">{d.rate_per_kg != null ? `₹${fmtDecimal(d.rate_per_kg, 2)}` : '—'}{d.quotation_no ? <span className="block text-slate-400">{d.quotation_no}</span> : null}</td>
                    <td className="td whitespace-nowrap">
                      <button className="rounded p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"
                        title="Print DC" onClick={() => setPrintDc(d.dc_no)} id={`btn-print-dc-${d.dc_no}`}>
                        <Printer size={13} />
                      </button>
                      <button className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
                        title="Unused yarn returned by the knitter" disabled={!(Number(d.balance_yarn_kg) > 0)}
                        onClick={() => setReturnDc(d.dc_no)} id={`btn-yarn-return-${d.dc_no}`}>
                        <Undo2 size={13} /> Yarn return
                      </button>
                      {(d.status !== 'CLOSED' || Number(d.yarn_to_return_kg) > 0) && (
                        <button className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                          title="Close the DC; optionally write off the yarn still with the knitter" onClick={() => closeDc(d)} id={`btn-close-dc-${d.dc_no}`}>
                          <X size={13} /> Close
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Grey fabric inwards</h5>
        {inwards.length === 0 ? <p className="py-3 text-center text-[12px] text-slate-400">No grey fabric received yet</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Inward No</th><th className="th">Date</th><th className="th">Our DC</th>
                  <th className="th">Knitter DC</th><th className="th">Lot</th><th className="th text-right">Rolls</th>
                  <th className="th text-right">Fabric KG</th><th className="th text-right">Yarn used</th>
                  <th className="th text-right">Loss</th><th className="th">Rolls</th>
                </tr>
              </thead>
              <tbody>
                {inwards.map((r: any) => (
                  <tr key={r.id} className="border-t border-slate-100 align-top">
                    <td className="td font-mono font-semibold text-brand-700">{r.receipt_no}</td>
                    <td className="td text-slate-500">{fmtDate(r.receipt_date)}</td>
                    <td className="td font-mono">{r.dc_nos || r.ref_dc_no || '—'}
                      <span className={`ml-1 rounded px-1 text-[10px] font-bold ${r.receipt_type === 'FINAL' ? 'bg-emerald-100 text-emerald-800' : r.receipt_type === 'ADJUST' ? 'bg-slate-200 text-slate-600' : 'bg-amber-100 text-amber-800'}`}>{r.receipt_type === 'FINAL' ? 'FINAL' : r.receipt_type === 'ADJUST' ? 'WRITE-OFF' : 'PARTIAL'}</span>
                      {r.gate_entry_no ? <span className="block text-[10px] text-slate-400">Gate {r.gate_entry_no}</span> : null}</td>
                    <td className="td font-mono">{r.party_dc_no ?? '—'}</td>
                    <td className="td">{r.output_lot_no}</td>
                    <td className="td text-right">{r.no_of_rolls}</td>
                    <td className="td text-right tabular-nums font-semibold text-emerald-700">{fmtDecimal(r.output_qty, 3)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.input_qty, 3)}</td>
                    <td className="td text-right tabular-nums text-rose-700">{fmtDecimal(r.loss_qty, 3)}</td>
                    <td className="td text-[11px] text-slate-500">
                      {(r.rolls ?? []).map((x: any) => `${x.roll_no} (${fmtDecimal(x.weight_kg, 2)})`).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h5 className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Unused yarn returns</h5>
        {yarnReturns.length === 0 ? <p className="py-3 text-center text-[12px] text-slate-400">No yarn returned by the knitter</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Return No</th><th className="th">Date</th><th className="th">Our DC</th>
                  <th className="th">Knitter DC</th><th className="th">Store</th><th className="th">Yarn / lot</th>
                  <th className="th text-right">Cones</th><th className="th text-right">KG</th><th className="th" />
                </tr>
              </thead>
              <tbody>
                {yarnReturns.map((r: any) => (
                  <tr key={r.id} className={`border-t border-slate-100 align-top ${r.status === 'CANCELLED' ? 'opacity-50 line-through' : ''}`}>
                    <td className="td font-mono font-semibold text-brand-700">{r.return_no}{r.status === 'CANCELLED' && <span className="ml-1 text-[10px] text-red-600 no-underline">cancelled</span>}</td>
                    <td className="td text-slate-500">{fmtDate(r.return_date)}</td>
                    <td className="td font-mono">{r.dc_no}</td>
                    <td className="td font-mono">{r.party_dc_no ?? '—'}</td>
                    <td className="td">{r.warehouse_name ?? '—'}</td>
                    <td className="td text-[11px] text-slate-600">
                      {(r.lines ?? []).map((l: any) =>
                        `${l.yarn_code ?? ''}${l.lot_no ? ` / ${l.lot_no}` : ''}: ${fmtDecimal(l.return_kg, 3)}`).join(', ')}
                    </td>
                    <td className="td text-right tabular-nums">{r.total_cones}</td>
                    <td className="td text-right tabular-nums font-semibold text-sky-700">{fmtDecimal(r.total_kg, 3)}</td>
                    <td className="td">
                      <button className="rounded p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600"
                        title="Print return note" onClick={() => setPrintReturn(r.return_no)} id={`btn-print-yr-${r.return_no}`}>
                        <Printer size={13} />
                      </button>
                      {r.status !== 'CANCELLED' && (
                        <button className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Cancel return"
                          onClick={() => cancelReturn(r)} id={`btn-cancel-yr-${r.return_no}`}>
                          <X size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <KnittingDcModal programId={dcOpen ? prog.id : null} open={dcOpen} onClose={() => setDcOpen(false)}
        onPrint={setPrintDc} />
      <KnittingInwardModal programId={inOpen ? prog.id : null} open={inOpen} onClose={() => setInOpen(false)} />
      <KnittingDcPrint dcNo={printDc} onClose={() => setPrintDc(null)} />
      <KnittingYarnReturnModal dcNo={returnDc} onClose={() => setReturnDc(null)} onPrint={setPrintReturn} />
      <KnittingYarnReturnPrint returnNo={printReturn} onClose={() => setPrintReturn(null)} />
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 font-medium text-slate-800">{value}</p>
    </div>
  );
}
