import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal } from '../../lib/format';
import { useSearchParams } from 'react-router-dom';

export function TraceabilitySearchPage() {
  const [searchParams] = useSearchParams();
  const [queryText, setQueryText] = useState(searchParams.get('io') || searchParams.get('style') || 'IO-2026-00125');
  const [quickResults, setQuickResults] = useState<any[]>([]);
  const [activeIo, setActiveIo] = useState<string>(searchParams.get('io') || 'IO-2026-00125');
  const [traceData, setTraceData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Live quick search
  useEffect(() => {
    if (queryText.trim().length >= 2) {
      api.get(`/traceability/search?q=${encodeURIComponent(queryText.trim())}`)
        .then(r => setQuickResults(r.data.data || []));
    } else {
      setQuickResults([]);
    }
  }, [queryText]);

  const loadTraceability = (ioNo: string) => {
    if (!ioNo) return;
    setLoading(true);
    setActiveIo(ioNo);
    api.get(`/io/${encodeURIComponent(ioNo)}/traceability`)
      .then(r => setTraceData(r.data.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadTraceability(activeIo);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadTraceability(queryText.trim());
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Universal Traceability Search</h1>
        <p className="text-sm text-slate-500">
          End-to-end forward and backward genealogy from Fabric Roll → Cutting → Bundle → Sewing → Finishing → FG → Packing → Shipment → Delivery
        </p>
      </div>

      {/* Search Bar */}
      <Card>
        <form onSubmit={handleSearchSubmit} className="p-4 flex gap-4 items-center">
          <div className="flex-1 relative">
            <Input
              placeholder="Search by I/O No, Style No, Bundle Barcode, Carton No, or Roll No..."
              value={queryText}
              onChange={e => setQueryText(e.target.value)}
              className="text-base font-mono"
            />
            {quickResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden divide-y">
                {quickResults.map((item, idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      setQueryText(item.key);
                      setQuickResults([]);
                      loadTraceability(item.key);
                    }}
                    className="p-2.5 hover:bg-indigo-50 cursor-pointer flex items-center justify-between text-xs"
                  >
                    <span className="font-medium text-slate-700">{item.label}</span>
                    <Badge color="indigo">{item.type}</Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Button type="submit" loading={loading}>Trace Genealogy</Button>
        </form>
      </Card>

      {/* Active I/O Overview Header */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 text-white shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold text-indigo-300 uppercase tracking-wider">Parent Production Reference</span>
          <h2 className="text-3xl font-mono font-black tracking-tight">{activeIo}</h2>
          <p className="text-xs text-indigo-200 mt-1">Full life-cycle forward/backward audit trail</p>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <span className="text-xs text-indigo-300">Cutting Plans</span>
            <p className="text-xl font-bold font-mono">{traceData?.cuttingPlans?.length || 0}</p>
          </div>
          <div>
            <span className="text-xs text-indigo-300">Bundles Tracked</span>
            <p className="text-xl font-bold font-mono">{traceData?.bundles?.length || 0}</p>
          </div>
          <div>
            <span className="text-xs text-indigo-300">Cartons Packed</span>
            <p className="text-xl font-bold font-mono">{traceData?.packings?.[0]?.total_cartons || 0}</p>
          </div>
          <div>
            <span className="text-xs text-indigo-300">Shipments</span>
            <p className="text-xl font-bold font-mono">{traceData?.shipments?.length || 0}</p>
          </div>
        </div>
      </div>

      {/* Horizontal Lifecycle Steps */}
      <div className="space-y-6">
        {/* Step 1 & 2: Sales Order & Cutting Plan */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="1. Sales Order & Production Order">
            <div className="p-4 space-y-3 text-sm">
              {traceData?.salesOrders?.length > 0 ? traceData.salesOrders.map((so: any) => (
                <div key={so.id} className="p-3 bg-slate-50 border rounded-lg flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold text-brand-700">{so.so_no}</span>
                    <p className="text-xs text-slate-500">Date: {fmtDate(so.so_date)}</p>
                  </div>
                  <span className="font-bold text-slate-800">{fmtNumber(so.order_qty)} PCS</span>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No Sales Order linked directly</p>}
            </div>
          </Card>

          <Card title="2. Cutting Plans">
            <div className="p-4 space-y-3 text-sm">
              {traceData?.cuttingPlans?.length > 0 ? traceData.cuttingPlans.map((cp: any) => (
                <div key={cp.id} className="p-3 bg-blue-50/50 border border-blue-100 rounded-lg flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold text-blue-900">{cp.plan_no}</span>
                    <p className="text-xs text-slate-500">Planned: {fmtNumber(cp.planned_cut_qty)} | Actual: {fmtNumber(cp.actual_cut_qty)}</p>
                  </div>
                  <Badge color="blue">{cp.status}</Badge>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No cutting plans created</p>}
            </div>
          </Card>
        </div>

        {/* Step 3 & 4: Fabric Issue & Lay / Spreading */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="3. Fabric Issuance (Roll-Level)">
            <div className="p-4 space-y-3 text-sm">
              {traceData?.fabricIssues?.length > 0 ? traceData.fabricIssues.map((fi: any) => (
                <div key={fi.id} className="p-3 bg-slate-50 border rounded-lg flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold text-slate-800">{fi.issue_no}</span>
                    <p className="text-xs text-slate-500">{fi.total_rolls} Rolls | {fmtDecimal(fi.total_mtr)} M | {fmtDecimal(fi.total_kg)} KG</p>
                  </div>
                  <Badge color="emerald">{fi.status}</Badge>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No fabric issue recorded</p>}
            </div>
          </Card>

          <Card title="4. Lay Plan & Spreading">
            <div className="p-4 space-y-3 text-sm">
              {traceData?.layPlans?.length > 0 ? traceData.layPlans.map((lp: any) => (
                <div key={lp.id} className="p-3 bg-slate-50 border rounded-lg flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold text-slate-800">{lp.lay_no}</span>
                    <p className="text-xs text-slate-500">Marker: {lp.marker_ref} | Plies: {lp.ply_count}</p>
                  </div>
                  <Badge color="indigo">{lp.status}</Badge>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No lay plan recorded</p>}
            </div>
          </Card>
        </div>

        {/* Step 5 & 6: Cutting & Cut QC & Bundles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="5. Cutting & Cut QC">
            <div className="p-4 space-y-3 text-sm">
              {traceData?.cuttings?.length > 0 ? traceData.cuttings.map((c: any) => (
                <div key={c.id} className="p-3 bg-slate-50 border rounded-lg flex justify-between items-center">
                  <div>
                    <span className="font-mono font-bold text-slate-800">{c.cut_no}</span>
                    <p className="text-xs text-slate-500">{fmtNumber(c.total_pieces)} Pieces Cut</p>
                  </div>
                  <Badge color="emerald">CUT</Badge>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No cutting record found</p>}

              {traceData?.cutQcs?.map((q: any) => (
                <div key={q.id} className="p-2.5 bg-emerald-50/50 border border-emerald-100 rounded text-xs flex justify-between">
                  <span>QC: {q.qc_no} ({q.component}) - Acc: {q.accepted_qty}, Rej: {q.reject_qty}</span>
                  <Badge color="emerald">{q.qc_status}</Badge>
                </div>
              ))}
            </div>
          </Card>

          <Card title="6. Bundle Generation & Movements">
            <div className="p-4 space-y-2 text-sm max-h-60 overflow-y-auto">
              {traceData?.bundles?.length > 0 ? traceData.bundles.map((b: any) => (
                <div key={b.id} className="p-2 bg-slate-50 border rounded flex justify-between items-center text-xs">
                  <div>
                    <span className="font-mono font-bold text-brand-700">{b.bundle_no}</span>
                    <span className="text-slate-400 ml-2 font-mono">({b.qty} pcs)</span>
                  </div>
                  <Badge color="blue">{b.status}</Badge>
                </div>
              )) : <p className="text-xs text-slate-400 italic">No bundles generated</p>}
            </div>
          </Card>
        </div>

        {/* Step 7 & 8: Sewing Floor & Finishing Floor */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card title="7. Sewing Line Progress">
            <div className="p-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 border rounded-lg">
                  <span className="text-xs text-slate-500">Sewing Inputs</span>
                  <p className="text-xl font-bold text-slate-800">{traceData?.sewingInputs?.length || 0} batches</p>
                </div>
                <div className="p-3 bg-slate-50 border rounded-lg">
                  <span className="text-xs text-slate-500">Sewing Outputs</span>
                  <p className="text-xl font-bold text-emerald-700">{traceData?.sewingOutputs?.length || 0} batches</p>
                </div>
              </div>
            </div>
          </Card>

          <Card title="8. Finishing & Final QC">
            <div className="p-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 border rounded-lg">
                  <span className="text-xs text-slate-500">Finished Garments</span>
                  <p className="text-xl font-bold text-slate-800">{traceData?.finishingOutputs?.length || 0} outputs</p>
                </div>
                <div className="p-3 bg-slate-50 border rounded-lg">
                  <span className="text-xs text-slate-500">Final QC Inspections</span>
                  <p className="text-xl font-bold text-blue-700">{traceData?.finalQcs?.length || 0} passed</p>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Step 9 & 10: FG, Packing, Shipment, Dispatch */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card title="9. FG Receipt">
            <div className="p-4 space-y-2 text-xs">
              {traceData?.fgReceipts?.map((fg: any) => (
                <div key={fg.id} className="p-2.5 bg-slate-50 border rounded flex justify-between">
                  <span className="font-mono font-semibold">{fg.receipt_no}</span>
                  <span className="font-bold text-emerald-700">{fmtNumber(fg.total_qty)} PCS</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="10. Packing & Packing List">
            <div className="p-4 space-y-2 text-xs">
              {traceData?.packingLists?.map((pl: any) => (
                <div key={pl.id} className="p-2.5 bg-slate-50 border rounded flex justify-between">
                  <span className="font-mono font-semibold">{pl.pl_no}</span>
                  <span>{pl.total_cartons} Cartons</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="11. Shipment & Dispatch">
            <div className="p-4 space-y-2 text-xs">
              {traceData?.shipments?.map((sh: any) => (
                <div key={sh.id} className="p-2.5 bg-blue-50/50 border border-blue-100 rounded flex justify-between">
                  <span className="font-mono font-semibold">{sh.shipment_no}</span>
                  <Badge color="blue">{sh.shipment_type}</Badge>
                </div>
              ))}
              {traceData?.dispatches?.map((dp: any) => (
                <div key={dp.id} className="p-2.5 bg-emerald-50/50 border border-emerald-100 rounded flex justify-between">
                  <span className="font-mono font-semibold">{dp.dispatch_no}</span>
                  <span className="font-mono text-[11px]">{dp.vehicle_no || 'Vehicle'}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default TraceabilitySearchPage;
