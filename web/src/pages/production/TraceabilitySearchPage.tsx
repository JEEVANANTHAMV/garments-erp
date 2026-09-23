import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Card, Badge, Button, Input, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber, fmtDecimal } from '../../lib/format';

/**
 * Traceability (doc §23, §25): forward fabric roll / lot → shipment and
 * backward shipment / carton → fabric roll → lot → GRN → PO, plus bundle
 * genealogy and the IO overview. URL params: ?bundle= ?roll= ?lot=
 * ?carton= ?shipment= ?io= ?style=. Every node links to its own trace.
 */

const KINDS = ['bundle', 'roll', 'lot', 'carton', 'shipment', 'io', 'style'] as const;
type Kind = typeof KINDS[number];
const link = (k: Kind, v: string) => `/production/traceability?${k}=${encodeURIComponent(v)}`;
const errMsg = (e: any) => e?.message || 'Not found';

export function TraceabilitySearchPage() {
  const [params, setParams] = useSearchParams();
  const active = KINDS.map((k) => [k, params.get(k)] as const).find(([, v]) => v);
  const [queryText, setQueryText] = useState(active?.[1] ?? '');
  const [quick, setQuick] = useState<any[]>([]);

  useEffect(() => { setQueryText(active?.[1] ?? ''); }, [active?.[0], active?.[1]]);
  useEffect(() => {
    const q = queryText.trim();
    if (q.length < 2 || q === active?.[1]) { setQuick([]); return; }
    const t = setTimeout(() => {
      api.get('/traceability/search', { params: { q } }).then((r) => setQuick(r.data.data || [])).catch(() => setQuick([]));
    }, 250);
    return () => clearTimeout(t);
  }, [queryText]);

  const go = (k: Kind, v: string) => { setQuick([]); setParams({ [k]: v }); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = queryText.trim();
    if (!q) return;
    // Exact hits first (bundle barcode, carton, shipment, roll, lot, IO), else the first suggestion.
    const r = await api.get('/traceability/search', { params: { q } }).catch(() => null);
    const list: any[] = r?.data?.data ?? [];
    const exact = list.find((x) => String(x.key).toLowerCase() === q.toLowerCase()) ?? list[0];
    const map: Record<string, Kind> = { BUNDLE: 'bundle', ROLL: 'roll', LOT: 'lot', CARTON: 'carton', SHIPMENT: 'shipment', 'I/O': 'io', STYLE: 'style' };
    if (exact) go(map[exact.type] ?? 'bundle', exact.key); else go('bundle', q);
  };

  return (
    <div className="space-y-5 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Traceability</h1>
        <p className="text-sm text-slate-500">
          Fabric roll → lay → cut output → bundle → sewing → finishing → carton → packing list → shipment, and back to lot, GRN and PO
        </p>
      </div>

      <Card>
        <form onSubmit={submit} className="p-4 flex gap-3 items-start">
          <div className="flex-1 relative">
            <Input placeholder="Scan / type a bundle barcode, fabric roll, lot, carton, shipment, IO or style…"
              value={queryText} onChange={(e) => setQueryText(e.target.value)} className="font-mono" autoFocus />
            {quick.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden divide-y">
                {quick.map((item, idx) => (
                  <Link key={idx} to={item.link} onClick={() => setQuick([])}
                    className="p-2.5 hover:bg-indigo-50 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">{item.label}</span>
                    <Badge color="indigo">{item.type}</Badge>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <Button type="submit">Trace</Button>
        </form>
      </Card>

      {!active && <p className="text-sm text-slate-400">Search for anything above — or open a bundle, roll, carton or shipment link from another screen.</p>}
      {active && ['bundle', 'roll', 'lot', 'carton', 'shipment'].includes(active[0]) && <ChainTrace kind={active[0]} value={active[1]!} />}
      {active?.[0] === 'io' && <IoTrace ioNo={active[1]!} />}
      {active?.[0] === 'style' && <StyleTrace style={active[1]!} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Roll / lot / bundle / carton / shipment chain
// ════════════════════════════════════════════════════════════════════
function ChainTrace({ kind, value }: { kind: Kind; value: string }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true); setError(''); setData(null);
    api.get(`/trace/${kind}/${encodeURIComponent(value)}`)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, [kind, value]);

  if (loading) return <p className="text-sm text-slate-500">Tracing {value}…</p>;
  if (error) return <Card><p className="p-6 text-sm text-red-600">{error}</p></Card>;
  if (!data) return null;

  const dirLabel = data.direction === 'FORWARD' ? 'Forward trace' : data.direction === 'BACKWARD' ? 'Backward trace' : 'Bundle genealogy';
  const s = data.summary ?? {};
  const bundles: any[] = data.bundles ?? [];
  const cutOrders = [...new Map((data.lays ?? []).filter((l: any) => l.plan_no).map((l: any) => [l.plan_no, l])).values()] as any[];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-5 text-white shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">{dirLabel} · {data.root?.type}</span>
          <h2 className="font-mono text-3xl font-black tracking-tight">{data.root?.key ?? value}</h2>
        </div>
        <div className="flex flex-wrap gap-6 text-right">
          <Stat label="Bundles" v={s.bundles} />
          <Stat label="Cut PCS" v={s.cut_pcs} />
          <Stat label="Sewn PCS" v={s.sewn_pcs} />
          <Stat label="Finished PCS" v={s.finished_pcs} />
          <Stat label="Packed PCS" v={s.packed_pcs} />
          <Stat label="Allocated KG" v={s.allocated_kg} dp={3} />
        </div>
      </div>

      {/* The chain, left = fabric source, right = shipment */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Col title="Fabric PO" items={data.pos ?? []} render={(p: any) => <span className="font-mono">{p.po_no}</span>} sub={(p: any) => fmtDate(p.po_date)} />
        <Col title="GRN" items={data.grns ?? []} render={(g: any) => <span className="font-mono">{g.grn_no}</span>} sub={(g: any) => g.supplier_name} />
        <Col title="Lot" items={data.lots ?? []} render={(l: string) => <Link className="font-mono text-brand-700 hover:underline" to={link('lot', l)}>{l}</Link>} />
        <Col title="Fabric rolls" items={dedupe(data.rolls ?? [], 'roll_no')} render={(r: any) => <Link className="font-mono text-brand-700 hover:underline" to={link('roll', r.roll_no)}>{r.roll_no}</Link>}
          sub={(r: any) => r.actual_consumed_kg != null ? `${fmtDecimal(r.actual_consumed_kg, 3)} KG used` : r.weight_kg != null ? `${fmtDecimal(r.weight_kg, 3)} KG` : ''} />
        <Col title="Cut order / Lay" items={data.lays ?? []} render={(l: any) => <span className="font-mono">{l.lay_no}</span>} sub={(l: any) => [l.plan_no, l.status].filter(Boolean).join(' · ')} />
        <Col title="Bundles" items={bundles.filter((b) => !['SPLIT', 'CLOSED'].includes(b.status))} max={12}
          render={(b: any) => <Link className="font-mono text-brand-700 hover:underline" to={link('bundle', b.barcode ?? b.bundle_no)}>{b.bundle_no}</Link>}
          sub={(b: any) => `${b.color_name ?? ''} ${b.size_code ?? ''} · ${b.qty} PCS · ${String(b.status).replace(/_/g, ' ')}`} />
        <Col title="Cartons" items={data.cartons ?? []} render={(c: any) => <Link className="font-mono text-brand-700 hover:underline" to={link('carton', c.carton_no)}>{c.carton_no}</Link>}
          sub={(c: any) => [c.pack_no, c.pcs != null ? `${c.pcs} PCS` : ''].filter(Boolean).join(' · ')} />
        <Col title="Packing list → Shipment" items={[...(data.packingLists ?? []).map((p: any) => ({ t: 'PL', ...p })), ...(data.shipments ?? []).map((x: any) => ({ t: 'SH', ...x }))]}
          render={(x: any) => x.t === 'PL' ? <span className="font-mono">{x.pl_no}</span> : <Link className="font-mono text-brand-700 hover:underline" to={link('shipment', x.shipment_no)}>{x.shipment_no}</Link>}
          sub={(x: any) => x.t === 'PL' ? `Packing list · ${x.status ?? ''}` : `Shipment${x.destination ? ` · ${x.destination}` : ''}`} />
      </div>
      {cutOrders.length > 0 && <p className="text-xs text-slate-500">Cut orders: {cutOrders.map((c) => c.plan_no).join(', ')}</p>}

      {data.bundle && <BundleCard b={data.bundle} />}

      {bundles.length > 0 && (
        <Card title={`Bundles (${bundles.length})`} subtitle="Stage quantities in PCS — split parents and merge sources shown greyed">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                {['Bundle', 'Colour', 'Size', 'Lay', 'Cut', 'Sewn', 'Finished', 'QC pass', 'Packed', 'Rejected', 'Alloc KG', 'Status'].map((h) => (
                  <th key={h} className={`px-2 py-1.5 ${['Bundle', 'Colour', 'Size', 'Lay', 'Status'].includes(h) ? 'text-left' : 'text-right'}`}>{h}</th>))}
              </tr></thead>
              <tbody>
                {bundles.map((b) => (
                  <tr key={b.id} className={`border-t border-slate-100 ${['SPLIT', 'CLOSED'].includes(b.status) ? 'text-slate-400' : ''}`}>
                    <td className="px-2 py-1 font-mono"><Link className="text-brand-700 hover:underline" to={link('bundle', b.barcode ?? b.bundle_no)}>{b.bundle_no}</Link>
                      {b.parent_bundle_no && <span className="ml-1 text-[10px] text-slate-400">← {b.parent_bundle_no}</span>}</td>
                    <td className="px-2 py-1">{b.color_name}</td><td className="px-2 py-1">{b.size_code}</td><td className="px-2 py-1">{b.lay_no ?? '—'}</td>
                    <td className="px-2 py-1 text-right">{b.qty}</td><td className="px-2 py-1 text-right">{b.sew_good_qty}</td>
                    <td className="px-2 py-1 text-right">{b.fin_good_qty}</td><td className="px-2 py-1 text-right">{b.qc_pass_qty}</td>
                    <td className="px-2 py-1 text-right">{b.packed_qty}</td><td className="px-2 py-1 text-right text-red-600">{b.avail?.rejected || '—'}</td>
                    <td className="px-2 py-1 text-right">{b.allocated_kg != null ? fmtDecimal(b.allocated_kg, 3) : '—'}</td>
                    <td className="px-2 py-1"><StatusBadge value={b.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(data.rolls ?? []).length > 0 && (
        <Card title="Fabric rolls">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                {['Roll', 'Lot', 'Fabric', 'Lay', 'DC', 'Before KG', 'After KG', 'Consumed KG', 'GRN', 'PO'].map((h) => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}
              </tr></thead>
              <tbody>
                {(data.rolls as any[]).map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono"><Link className="text-brand-700 hover:underline" to={link('roll', r.roll_no)}>{r.roll_no}</Link></td>
                    <td className="px-2 py-1">{r.lot_no ? <Link className="text-brand-700 hover:underline" to={link('lot', r.lot_no)}>{r.lot_no}</Link> : '—'}</td>
                    <td className="px-2 py-1">{r.fabric_name ?? '—'}</td><td className="px-2 py-1">{r.lay_no ?? '—'}</td><td className="px-2 py-1">{r.dc_no ?? r.issue_no ?? '—'}</td>
                    <td className="px-2 py-1">{r.before_kg != null ? fmtDecimal(r.before_kg, 3) : r.weight_kg != null ? fmtDecimal(r.weight_kg, 3) : '—'}</td>
                    <td className="px-2 py-1">{r.after_kg != null ? fmtDecimal(r.after_kg, 3) : '—'}</td>
                    <td className="px-2 py-1 font-semibold">{r.actual_consumed_kg != null ? fmtDecimal(r.actual_consumed_kg, 3) : '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.grn_no ?? '—'}</td><td className="px-2 py-1 font-mono">{r.po_no ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function dedupe(rows: any[], key: string) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r[key]) ? false : (seen.add(r[key]), true)));
}

function Stat({ label, v, dp = 0 }: { label: string; v?: number; dp?: number }) {
  return <div><span className="text-xs text-indigo-300">{label}</span><p className="font-mono text-xl font-bold">{dp ? fmtDecimal(v ?? 0, dp) : fmtNumber(v ?? 0)}</p></div>;
}

function Col<T>({ title, items, render, sub, max = 8 }: { title: string; items: T[]; render: (x: T) => React.ReactNode; sub?: (x: T) => React.ReactNode; max?: number }) {
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-slate-500">
        {title} <span className="rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-600">{items.length}</span>
      </p>
      <div className="space-y-1.5 text-xs">
        {items.length === 0 && <p className="italic text-slate-300">none</p>}
        {items.slice(0, max).map((x, i) => (
          <div key={i}>
            <div>{render(x)}</div>
            {sub && <div className="text-[10px] text-slate-400">{sub(x)}</div>}
          </div>
        ))}
        {items.length > max && <p className="text-[10px] text-slate-400">+{items.length - max} more</p>}
      </div>
      <ArrowRight size={14} className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-slate-300 xl:block" />
    </div>
  );
}

function BundleCard({ b }: { b: any }) {
  const a = b.avail ?? {};
  return (
    <Card title={`Bundle ${b.bundle_no}`} subtitle={`${b.style_code ?? ''} · ${b.color_name ?? ''} · Size ${b.size_code ?? ''} · ${b.part_name ?? ''} · IO ${b.io_no ?? '—'}`}
      actions={<StatusBadge value={b.status} />}>
      <div className="p-4 space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KV k="Barcode" v={<span className="font-mono">{b.barcode}</span>} />
          <KV k="Bundle qty" v={`${fmtNumber(b.qty)} PCS`} />
          <KV k="Cut order" v={b.plan_no ?? '—'} />
          <KV k="Lay" v={b.lay_no ?? '—'} />
          <KV k="Marker" v={b.marker_no ? `${b.marker_no} v${b.marker_version}` : b.marker_ref ?? '—'} />
          <KV k="Cut output" v={b.output_no ?? '—'} />
          <KV k="Allocated fabric" v={b.allocated_kg != null ? `${fmtDecimal(b.allocated_kg, 3)} KG (${b.allocation_method ?? '—'})` : '—'} />
          <KV k="Lots" v={(b.lots ?? []).join(', ') || '—'} />
          {b.parent_bundle_no && <KV k="Split from" v={<Link className="font-mono text-brand-700" to={link('bundle', b.parent_barcode ?? b.parent_bundle_no)}>{b.parent_bundle_no}</Link>} />}
          {b.children?.length > 0 && <KV k="Split into" v={b.children.map((c: any) => <Link key={c.id} className="mr-2 font-mono text-brand-700" to={link('bundle', c.barcode ?? c.bundle_no)}>{c.bundle_no} ({c.qty})</Link>)} />}
          {b.merge_sources?.length > 0 && <KV k="Merged from" v={b.merge_sources.map((c: any) => <Link key={c.source_bundle_id} className="mr-2 font-mono text-brand-700" to={link('bundle', c.barcode ?? c.bundle_no)}>{c.bundle_no} ({c.qty})</Link>)} />}
          {b.merged_into?.length > 0 && <KV k="Merged into" v={b.merged_into.map((c: any) => <Link key={c.merged_bundle_id} className="mr-2 font-mono text-brand-700" to={link('bundle', c.barcode ?? c.bundle_no)}>{c.bundle_no}</Link>)} />}
          {b.current_carton && <KV k="Carton" v={<Link className="font-mono text-brand-700" to={link('carton', b.current_carton.carton_no)}>{b.current_carton.carton_no}</Link>} />}
        </div>
        <div className="grid grid-cols-3 gap-2 md:grid-cols-7 text-center">
          {[['At cutting', a.cut], ['Sewing WIP', a.sewing_wip], ['Sewn', a.sewn], ['Finishing WIP', a.finishing_wip], ['Awaiting QC', a.qc], ['Ready to pack', a.pack], ['Packed', a.packed]].map(([k, v]) => (
            <div key={k as string} className="rounded-lg border border-slate-200 px-2 py-1.5">
              <p className="text-[10px] uppercase text-slate-400">{k}</p><p className="font-bold">{fmtNumber(v)} <span className="text-[10px] text-slate-400">PCS</span></p>
            </div>
          ))}
        </div>
        {b.dcs?.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-600">Process DCs</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {b.dcs.map((d: any) => (
                <Link key={d.line_id} to={`/production/jobwork-challans?dc=${d.challan_id}`} className="rounded border border-slate-200 px-2 py-1 hover:border-brand-400">
                  <span className="font-mono">{d.challan_no}</span> · {d.stage_name} · {d.vendor_name} · sent {d.qty} / recd {d.received_qty} PCS <StatusBadge value={d.status} />
                </Link>
              ))}
            </div>
          </div>
        )}
        {b.history?.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-600">Movement history</p>
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50 text-slate-500"><tr>
                {['When', 'Movement', 'From → To', 'Qty (PCS)', 'Good', 'Reject', 'Where', 'By', 'Remarks'].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}
              </tr></thead>
              <tbody>
                {b.history.map((h: any) => (
                  <tr key={h.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-500">{fmtDateTime(h.moved_at)}</td>
                    <td className="px-2 py-1"><Badge tone="blue">{String(h.txn_type ?? '').replace(/_/g, ' ') || '—'}</Badge></td>
                    <td className="px-2 py-1">{h.from_stage} → {h.to_stage}</td>
                    <td className="px-2 py-1">{h.moved_qty}</td><td className="px-2 py-1">{h.good_qty ?? '—'}</td><td className="px-2 py-1">{h.reject_qty ?? '—'}</td>
                    <td className="px-2 py-1">{[h.location, h.work_center].filter(Boolean).join(' / ') || h.destination || '—'}</td>
                    <td className="px-2 py-1">{h.moved_by_name}</td><td className="px-2 py-1 text-slate-500">{h.remarks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><p className="text-[11px] uppercase tracking-wide text-slate-400">{k}</p><div className="font-medium text-slate-800">{v}</div></div>;
}

// ════════════════════════════════════════════════════════════════════
// IO overview (all documents carrying the IO no)
// ════════════════════════════════════════════════════════════════════
function IoTrace({ ioNo }: { ioNo: string }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setD(null); setError('');
    api.get(`/io/${encodeURIComponent(ioNo)}/traceability`).then((r) => setD(r.data.data)).catch((e) => setError(errMsg(e)));
  }, [ioNo]);
  if (error) return <Card><p className="p-6 text-sm text-red-600">{error}</p></Card>;
  if (!d) return <p className="text-sm text-slate-500">Loading {ioNo}…</p>;
  const sections: [string, any[], (x: any) => React.ReactNode][] = [
    ['Sales orders', d.salesOrders, (x) => <><b className="font-mono">{x.so_no}</b> · {fmtNumber(x.order_qty)} PCS</>],
    ['Cutting plans', d.cuttingPlans, (x) => <><b className="font-mono">{x.plan_no}</b> · planned {fmtNumber(x.planned_cut_qty)} / cut {fmtNumber(x.actual_cut_qty)} PCS · {x.status}</>],
    ['Fabric DCs', d.fabricIssues, (x) => <><b className="font-mono">{x.issue_no}</b> · {x.total_rolls} rolls · {fmtDecimal(x.total_kg, 3)} KG</>],
    ['Lays', d.layPlans, (x) => <><b className="font-mono">{x.lay_no}</b> · {x.ply_count ?? 0} plies · {x.status}</>],
    ['Bundles', d.bundles, (x) => <Link className="font-mono text-brand-700 hover:underline" to={link('bundle', x.barcode ?? x.bundle_no)}>{x.bundle_no} · {x.qty} PCS · {x.status}</Link>],
    ['Sewing inputs', d.sewingInputs, (x) => <><b className="font-mono">{x.input_no}</b> · {x.line_name} · {x.input_qty} PCS</>],
    ['Finishing outputs', d.finishingOutputs, (x) => <><b className="font-mono">{x.output_no}</b> · {x.output_qty} PCS</>],
    ['Final QC', d.finalQcs, (x) => <><b className="font-mono">{x.qc_no}</b> · pass {x.passed_qty} / rej {x.reject_qty} PCS</>],
    ['Packing lists', d.packingLists, (x) => <><b className="font-mono">{x.pl_no}</b> · {x.total_cartons ?? 0} cartons · {fmtNumber(x.total_qty)} PCS</>],
    ['Shipments', d.shipments, (x) => <Link className="font-mono text-brand-700 hover:underline" to={link('shipment', x.shipment_no)}>{x.shipment_no} · {fmtNumber(x.total_qty)} PCS</Link>],
  ];
  return (
    <div className="space-y-4">
      <h2 className="font-mono text-2xl font-black text-slate-800">{ioNo}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {sections.map(([title, rows, render]) => (
          <Card key={title} title={`${title} (${rows?.length ?? 0})`}>
            <div className="max-h-60 overflow-y-auto p-3 space-y-1.5 text-xs">
              {rows?.length ? rows.map((x: any, i: number) => <div key={x.id ?? i} className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5">{render(x)}</div>)
                : <p className="italic text-slate-400">None</p>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function StyleTrace({ style }: { style: string }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setD(null); setError('');
    api.get(`/style/${encodeURIComponent(style)}/production-history`).then((r) => setD(r.data.data)).catch((e) => setError(errMsg(e)));
  }, [style]);
  if (error) return <Card><p className="p-6 text-sm text-red-600">{error}</p></Card>;
  if (!d) return <p className="text-sm text-slate-500">Loading {style}…</p>;
  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-black text-slate-800">{d.style.style_code} <span className="text-base font-medium text-slate-500">{d.style.style_name}</span></h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Cut', d.summary.total_cut], ['FG received', d.summary.total_fg], ['Packed', d.summary.total_packed], ['Shipped', d.summary.total_shipped]].map(([k, v]) => (
          <Card key={k}><div className="p-4"><p className="text-xs text-slate-500">{k}</p><p className="text-2xl font-bold">{fmtNumber(v)} <span className="text-xs text-slate-400">PCS</span></p></div></Card>
        ))}
      </div>
      <Card title="Orders">
        <div className="p-3 space-y-1.5 text-xs">
          {d.orders.length ? d.orders.map((o: any, i: number) => (
            <div key={i} className="rounded border border-slate-100 bg-slate-50 px-2 py-1.5">
              <b className="font-mono">{o.so_no}</b> · {fmtNumber(o.order_qty)} PCS · {o.io_no ? <Link className="text-brand-700 hover:underline" to={link('io', o.io_no)}>{o.io_no}</Link> : '—'}
            </div>)) : <p className="italic text-slate-400">None</p>}
        </div>
      </Card>
    </div>
  );
}

export default TraceabilitySearchPage;
