import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { SearchSelect, ScanInput, Qty, MetricTile, ALLOCATED_KG_LABEL, errMsg } from './cuttingUi';

export function CutQcBundlesPage() {
  const [activeTab, setActiveTab] = useState<'bundles' | 'cut_qc' | 'scanner'>('bundles');
  const [bundles, setBundles] = useState<any[]>([]);
  const [cutQcs, setCutQcs] = useState<any[]>([]);
  const [cuttings, setCuttings] = useState<any[]>([]);
  const [cutOutputs, setCutOutputs] = useState<any[]>([]);
  const [genMode, setGenMode] = useState<'OUTPUT' | 'LEGACY'>('OUTPUT');
  const [genOutput, setGenOutput] = useState<any>({ cut_output_id: '', bundle_size: 10, qty: '', part_name: '', components: '' });
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  // New Bundle Generator Form
  const [showBundleModal, setShowBundleModal] = useState(false);
  const [selectedPartFilter, setSelectedPartFilter] = useState<string>('ALL');
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [printBundle, setPrintBundle] = useState<any>(null);

  const [bundleForm, setBundleForm] = useState<any>({
    cutting_id: '',
    io_no: '',
    style_id: '',
    color_id: '',
    size_id: '',
    part_name: 'TOP',
    custom_part: '',
    total_qty: 600,
    bundle_size: 20,
    components: 'FRONT,BACK,SLEEVE_L,SLEEVE_R,COLLAR,CUFF',
  });

  // Cut QC Form
  const [showQcModal, setShowQcModal] = useState(false);
  const [qcForm, setQcForm] = useState<any>({
    qc_no: '',
    qc_date: today(),
    cutting_id: '',
    io_no: '',
    style_id: '',
    color_id: '',
    size_id: '',
    component: 'FRONT',
    cut_qty: 3000,
    accepted_qty: 2980,
    reject_qty: 20,
    recut_qty: 20,
    reject_reason: 'Fabric Defect',
    qc_status: 'APPROVED',
    inspector_name: '',
    remarks: '',
  });

  // Scanner State
  const [scanCode, setScanCode] = useState('');
  const [scannedBundle, setScannedBundle] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([
      api.get('/bundles'),
      api.get('/cut-piece-qc'),
      api.get('/cuttings', { params: { pageSize: 200 } }).catch(() => ({ data: { data: [] } })),
      api.get('/cut-outputs', { params: { open: 1 } }),
    ]).then(([b, q, c, co]) => {
      setBundles(b.data.data || []);
      setCutQcs(q.data.data || []);
      setCuttings(c.data.data || []);
      setCutOutputs(co.data.data || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAll();
  }, []);

  // Live allocated-KG preview for the selected cut output (doc §12).
  useEffect(() => {
    setPreview(null);
    if (genMode !== 'OUTPUT' || !genOutput.cut_output_id || !(Number(genOutput.bundle_size) > 0)) return;
    const t = setTimeout(() => {
      api.get(`/cut-outputs/${genOutput.cut_output_id}/allocation-preview`, {
        params: { bundle_size: genOutput.bundle_size, qty: genOutput.qty || undefined },
      }).then(r => setPreview(r.data.data)).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [genMode, genOutput.cut_output_id, genOutput.bundle_size, genOutput.qty]);

  const handleGenerateFromOutput = async () => {
    if (!genOutput.cut_output_id) { toast('Select a cut output', 'error'); return; }
    setSaving(true);
    try {
      const r = await api.post(`/cut-outputs/${genOutput.cut_output_id}/bundles`, {
        bundle_size: Number(genOutput.bundle_size),
        qty: genOutput.qty ? Number(genOutput.qty) : undefined,
        part_name: genOutput.part_name || null,
        components: String(genOutput.components || '').split(',').map((s: string) => s.trim()).filter(Boolean),
      });
      toast(`${r.data.data.bundles.length} bundles generated from ${r.data.data.output_no}`);
      setShowBundleModal(false);
      setGenOutput({ cut_output_id: '', bundle_size: 10, qty: '', part_name: '', components: '' });
      fetchAll();
    } catch (e: any) {
      toast(errMsg(e, 'Failed to generate bundles'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCuttingSelectForBundle = (cutId: string) => {
    const cut = cuttings.find(c => String(c.id) === cutId);
    setBundleForm((prev: any) => ({
      ...prev,
      cutting_id: cutId,
      io_no: cut?.io_no || '',
      style_id: cut?.style_id || 1,
      color_id: cut?.color_id || 1,
      size_id: cut?.size_id || 1,
      total_qty: cut?.total_pieces || 500,
    }));
  };

  const handleGenerateBundles = async () => {
    if (!bundleForm.cutting_id) {
      toast('Please select a Cutting transaction', 'error');
      return;
    }
    setSaving(true);
    try {
      const components = bundleForm.components.split(',').map((s: string) => s.trim()).filter(Boolean);
      const effectivePart = bundleForm.part_name === 'CUSTOM'
        ? (bundleForm.custom_part || 'CUSTOM').trim().toUpperCase()
        : (bundleForm.part_name || 'TOP').toUpperCase();

      await api.post('/bundles/generate-detailed', {
        ...bundleForm,
        cutting_id: Number(bundleForm.cutting_id),
        style_id: Number(bundleForm.style_id),
        color_id: Number(bundleForm.color_id),
        size_id: Number(bundleForm.size_id),
        part_name: effectivePart,
        components,
      });
      toast(`Bundles generated for Part: ${effectivePart}!`);
      setShowBundleModal(false);
      fetchAll();
    } catch (e: any) {
      toast(errMsg(e, 'Failed to generate bundles'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveQc = async () => {
    if (!qcForm.cutting_id) {
      toast('Please select a Cutting record', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/cut-piece-qc', {
        ...qcForm,
        cutting_id: Number(qcForm.cutting_id),
        style_id: Number(qcForm.style_id || 1),
      });
      toast('Cut piece QC recorded');
      setShowQcModal(false);
      fetchAll();
    } catch (e: any) {
      toast(errMsg(e, 'Failed to record QC'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scanCode.trim()) return;
    setScanning(true);
    try {
      const r = await api.get(`/bundles/scan/${encodeURIComponent(scanCode.trim())}`);
      setScannedBundle(r.data.data);
      toast('Bundle found');
    } catch (e: any) {
      toast(errMsg(e, 'Bundle barcode not found'), 'error');
      setScannedBundle(null);
    } finally {
      setScanning(false);
    }
  };

  const handleMoveBundle = async (bundleId: number, nextStage: string) => {
    try {
      await api.post(`/bundles/${bundleId}/move`, { to_stage: nextStage });
      toast(`Bundle moved to ${nextStage}`);
      if (scannedBundle && scannedBundle.id === bundleId) {
        setScannedBundle({ ...scannedBundle, status: nextStage });
      }
      fetchAll();
    } catch (e: any) {
      toast(errMsg(e, 'Move failed'), 'error');
    }
  };

  const filteredBundles = bundles.filter((b: any) => {
    if (selectedPartFilter === 'ALL') return true;
    return (b.part_name || 'TOP').toUpperCase() === selectedPartFilter;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cut Piece QC & Bundles</h1>
          <p className="text-sm text-slate-500">Component QC, garment part barcode generation (TOP / BOTTOM / FOLDING), and floor stage tracking</p>
        </div>
        <div className="flex gap-2">
          {activeTab === 'bundles' && filteredBundles.length > 0 && (
            <Button variant="outline" onClick={() => { setPrintBundle(null); setShowPrintModal(true); }}>
              🖨️ Print Tickets ({filteredBundles.length})
            </Button>
          )}
          <Button variant="outline" onClick={() => setShowQcModal(true)}>+ Record Cut QC</Button>
          <Button onClick={() => setShowBundleModal(true)}>+ Generate Bundles</Button>
        </div>
      </div>

      <div className="flex border-b border-slate-200 gap-6 text-sm font-medium">
        <button
          onClick={() => setActiveTab('bundles')}
          className={`pb-3 ${activeTab === 'bundles' ? 'border-b-2 border-brand-600 text-brand-700 font-bold' : 'text-slate-500'}`}
        >
          Bundles List ({bundles.length})
        </button>
        <button
          onClick={() => setActiveTab('scanner')}
          className={`pb-3 ${activeTab === 'scanner' ? 'border-b-2 border-brand-600 text-brand-700 font-bold' : 'text-slate-500'}`}
        >
          🔍 Barcode Scanner & Floor Movement
        </button>
        <button
          onClick={() => setActiveTab('cut_qc')}
          className={`pb-3 ${activeTab === 'cut_qc' ? 'border-b-2 border-brand-600 text-brand-700 font-bold' : 'text-slate-500'}`}
        >
          Cut Piece QC ({cutQcs.length})
        </button>
      </div>

      {activeTab === 'bundles' && (
        <Card>
          {/* Part Filter Bar */}
          <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-slate-600 mr-1">Filter by Part:</span>
              {['ALL', 'TOP', 'BOTTOM', 'FOLDING', 'COLLAR'].map(p => (
                <button
                  key={p}
                  onClick={() => setSelectedPartFilter(p)}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-all ${
                    selectedPartFilter === p
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {p === 'ALL' ? `All Parts (${bundles.length})` : p}
                </button>
              ))}
            </div>
            <div className="text-slate-500 font-mono">
              Showing {filteredBundles.length} of {bundles.length} bundles
            </div>
          </div>

          <DataTable
            data={filteredBundles}
            loading={loading}
            columns={[
              { key: 'bundle_no', header: 'Bundle No & Sequence', sortable: true, render: (r: any) => (
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs font-bold text-brand-700">{r.bundle_no}</span>
                    {r.bundle_seq ? (
                      <span className="rounded bg-slate-100 text-slate-700 px-1.5 py-0.5 text-[10px] font-mono font-bold">
                        #{r.bundle_seq} / {r.total_bundles || '?'}
                      </span>
                    ) : null}
                  </div>
                  {r.barcode && <p className="font-mono text-[10px] text-slate-400">{r.barcode}</p>}
                </div>
              ) },
              { key: 'part_name', header: 'Part', sortable: true, render: (r: any) => {
                const part = (r.part_name || 'TOP').toUpperCase();
                const colors: Record<string, string> = {
                  TOP: 'blue',
                  BOTTOM: 'emerald',
                  FOLDING: 'purple',
                  COLLAR: 'amber',
                  FULL_SET: 'indigo',
                };
                return <Badge color={colors[part] || 'slate'}>{part}</Badge>;
              } },
              { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
              { key: 'style_code', header: 'Style' },
              { key: 'color_name', header: 'Colour' },
              { key: 'size_code', header: 'Size' },
              { key: 'lay_no', header: 'Cut Order / Lay', render: (r: any) => (
                <div className="text-[11px]"><p className="font-mono">{r.plan_no || r.cut_no || '—'}</p>
                  <p className="text-slate-400">{r.lay_no || ''}{r.marker_no ? ` · ${r.marker_no} v${r.marker_version}` : ''}</p></div>) },
              { key: 'qty', header: 'Qty', align: 'right' as const, render: (r: any) => <Qty v={r.qty} uom="PCS" className="font-semibold text-blue-700" /> },
              { key: 'balance_qty', header: 'Balance', align: 'right' as const, render: (r: any) => <Qty v={r.balance_qty ?? r.qty} uom="PCS" /> },
              { key: 'allocated_kg', header: 'Allocated KG*', align: 'right' as const, render: (r: any) => (
                <span title={`${ALLOCATED_KG_LABEL}${r.allocation_source ? ' — ' + r.allocation_source : ''}`}>
                  <Qty v={r.allocated_kg} uom="KG" dp={3} />
                  {r.allocation_method && <span className="block text-[9px] text-slate-400">{r.allocation_method === 'LAY_AVERAGE' ? 'lay average' : 'size consumption'}</span>}
                </span>) },
              { key: 'status', header: 'Stage', render: (r: any) => {
                const colors: Record<string, string> = {
                  GENERATED: 'slate', CHECKED: 'blue', ISSUED: 'indigo',
                  IN_SEWING: 'amber', COMPLETED: 'emerald', FINISHING: 'violet', CLOSED: 'gray',
                };
                return <Badge color={colors[r.status] || 'slate'}>{r.status}</Badge>;
              } },
              { key: 'actions', header: 'Actions', align: 'right' as const, render: (r: any) => (
                <div className="flex justify-end gap-1 items-center">
                  <Button size="sm" variant="ghost" onClick={() => { setPrintBundle(r); setShowPrintModal(true); }}>
                    🏷️
                  </Button>
                  {r.status === 'GENERATED' && (
                    <Button size="sm" variant="outline" onClick={() => handleMoveBundle(r.id, 'CHECKED')}>Verify</Button>
                  )}
                </div>
              ) },
            ]}
          />
        </Card>
      )}

      {activeTab === 'scanner' && (
        <div className="space-y-6 max-w-3xl">
          <Card title="Quick Floor Scanner">
            <form onSubmit={handleScan} className="p-6 flex gap-4">
              <Input
                placeholder="Scan or type bundle barcode / bundle number..."
                value={scanCode}
                onChange={e => setScanCode(e.target.value)}
                className="flex-1 text-base font-mono"
              />
              <Button type="submit" loading={scanning}>Scan</Button>
            </form>
          </Card>

          {scannedBundle && (
            <Card title={`Bundle Information — ${scannedBundle.bundle_no}`}>
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-4 gap-4 p-4 bg-slate-50 rounded-lg">
                  <div>
                    <span className="text-xs text-slate-500">Garment Part</span>
                    <p className="mt-1">
                      <Badge color={(scannedBundle.part_name || 'TOP').toUpperCase() === 'BOTTOM' ? 'emerald' : 'blue'} size="lg">
                        {(scannedBundle.part_name || 'TOP').toUpperCase()}
                      </Badge>
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">Bundle Seq</span>
                    <p className="font-mono font-bold text-slate-800 text-lg">
                      {scannedBundle.bundle_seq ? `#${scannedBundle.bundle_seq} / ${scannedBundle.total_bundles || '?'}` : scannedBundle.bundle_no}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">I/O No & Style</span>
                    <p className="font-semibold text-slate-800">{scannedBundle.io_no} — {scannedBundle.style_code} ({scannedBundle.color_name} - {scannedBundle.size_code})</p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">Quantity</span>
                    <p className="text-xl font-bold text-blue-700">{scannedBundle.qty} PCS</p>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Components in this Bundle</h4>
                  <div className="flex flex-wrap gap-2">
                    {scannedBundle.components?.map((c: any) => (
                      <span key={c.id} className="px-2.5 py-1 bg-white border border-slate-200 rounded-md text-xs font-mono font-medium text-slate-700">
                        {c.component} ({c.piece_qty} pcs)
                      </span>
                    ))}
                  </div>
                </div>

                <div className="border-t pt-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-600">Current Stage:</span>
                    <Badge color="blue" size="lg">{scannedBundle.status}</Badge>
                  </div>

                  <div className="flex gap-2">
                    {scannedBundle.status === 'GENERATED' ? (
                      <Button size="sm" variant="outline" onClick={() => handleMoveBundle(scannedBundle.id, 'CHECKED')}>→ CHECKED (verify)</Button>
                    ) : (
                      <span className="text-xs text-slate-500">Issue / sewing / finishing / packing moves are posted from the Sewing &amp; Finishing floor and DC screens.</span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'cut_qc' && (
        <Card>
          <DataTable
            data={cutQcs}
            loading={loading}
            columns={[
              { key: 'qc_no', header: 'QC No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-semibold text-brand-700">{r.qc_no}</span> },
              { key: 'qc_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.qc_date) },
              { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
              { key: 'component', header: 'Component', render: (r: any) => <Badge color="slate">{r.component}</Badge> },
              { key: 'cut_qty', header: 'Cut Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.cut_qty) },
              { key: 'accepted_qty', header: 'Accepted', align: 'right' as const, render: (r: any) => <span className="text-emerald-700 font-semibold">{fmtNumber(r.accepted_qty)}</span> },
              { key: 'reject_qty', header: 'Reject', align: 'right' as const, render: (r: any) => <span className="text-red-600 font-semibold">{fmtNumber(r.reject_qty)}</span> },
              { key: 'recut_qty', header: 'Recut', align: 'right' as const, render: (r: any) => fmtNumber(r.recut_qty) },
              { key: 'reject_reason', header: 'Reason' },
              { key: 'qc_status', header: 'Status', render: (r: any) => <Badge color={r.qc_status === 'APPROVED' ? 'emerald' : 'red'}>{r.qc_status}</Badge> },
            ]}
          />
        </Card>
      )}

      {/* Generate Bundles Modal */}
      {showBundleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-3xl bg-white rounded-xl shadow-xl my-8">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Generate Bundles</h3>
              <button onClick={() => setShowBundleModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>
            <div className="flex gap-2 border-b px-6 pt-3 text-xs font-semibold">
              <button className={`pb-2 ${genMode === 'OUTPUT' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500'}`} onClick={() => setGenMode('OUTPUT')}>From cut output (lay)</button>
              <button className={`pb-2 ${genMode === 'LEGACY' ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-500'}`} onClick={() => setGenMode('LEGACY')}>Legacy cutting entry</button>
            </div>

            {genMode === 'OUTPUT' ? (() => {
              const co = cutOutputs.find((c: any) => String(c.id) === String(genOutput.cut_output_id));
              return (
                <div className="p-6 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <SearchSelect label="Cut output" required value={genOutput.cut_output_id}
                      onChange={v => setGenOutput({ ...genOutput, cut_output_id: v, qty: '' })}
                      placeholder={cutOutputs.length ? 'Select size-wise cut output' : 'No open cut output — execute a lay first'}
                      options={cutOutputs.map((c: any) => ({
                        value: c.id, label: `${c.output_no} · ${c.plan_no} · ${c.lay_no} · Size ${c.size_code}`,
                        sub: `${c.style_code || ''} ${c.color_name || ''} · good ${c.good_qty} PCS · bundled ${c.bundled_qty} PCS`,
                        right: `${c.remaining_qty} PCS left`,
                      }))} />
                    <ScanInput label="Scan / type cut output no" onScan={code => {
                      const hit = cutOutputs.find((c: any) => String(c.output_no).toUpperCase() === code.toUpperCase());
                      if (!hit) { toast(`Cut output ${code} not found or fully bundled`, 'error'); return; }
                      setGenOutput({ ...genOutput, cut_output_id: String(hit.id), qty: '' });
                    }} />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Input label="Bundle size (PCS / bundle)" type="number" min={1} value={genOutput.bundle_size}
                      onChange={e => setGenOutput({ ...genOutput, bundle_size: e.target.value })} />
                    <Input label={`PCS to bundle${co ? ` (max ${co.remaining_qty} PCS)` : ''}`} type="number" min={1}
                      placeholder={co ? String(co.remaining_qty) : ''} value={genOutput.qty}
                      onChange={e => setGenOutput({ ...genOutput, qty: e.target.value })} />
                    <Input label="Garment part" placeholder={co?.part_name || 'TOP'} value={genOutput.part_name}
                      onChange={e => setGenOutput({ ...genOutput, part_name: e.target.value.toUpperCase() })} />
                    <Input label="Components (comma separated)" placeholder="FRONT,BACK,SLEEVE" value={genOutput.components}
                      onChange={e => setGenOutput({ ...genOutput, components: e.target.value })} />
                  </div>
                  {co && Number(genOutput.qty) > Number(co.remaining_qty) && (
                    <p className="text-xs font-semibold text-red-600">Bundle quantity cannot exceed the cut output balance of {co.remaining_qty} PCS.</p>
                  )}
                  {preview && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3 space-y-2">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <MetricTile label="Bundles" value={preview.bundle_count} sub={`last bundle ${preview.last_bundle_qty} PCS`} />
                        <MetricTile label="PCS" value={fmtNumber(preview.qty)} uom="PCS" />
                        <MetricTile label="KG / PC" value={preview.kg_per_pc != null ? fmtNumber(preview.kg_per_pc, 4) : '—'} uom="KG" />
                        <MetricTile label={`Per ${preview.bundle_size}-PC bundle`} value={preview.allocated_kg_per_full_bundle != null ? fmtNumber(preview.allocated_kg_per_full_bundle, 3) : '—'} uom="KG" tone="indigo" />
                      </div>
                      <p className="text-[11px] text-blue-900"><b>{ALLOCATED_KG_LABEL}.</b> Basis: {preview.allocation_method || 'none'} — {preview.allocation_source || 'no consumption source available'}.</p>
                    </div>
                  )}
                </div>
              );
            })() : (
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="Cutting Transaction *"
                  value={bundleForm.cutting_id}
                  onChange={e => handleCuttingSelectForBundle(e.target.value)}
                  options={[
                    { value: '', label: '— Select Cutting Entry —' },
                    ...cuttings.map(c => ({ value: c.id, label: `${c.cut_no} (I/O: ${c.io_no || 'N/A'}, Qty: ${c.total_pieces})` })),
                  ]}
                />
                <Input label="I/O No" value={bundleForm.io_no} disabled />
              </div>

              {/* Garment Part Selector */}
              <div className="grid grid-cols-2 gap-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Garment Part *</label>
                  <select
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    value={bundleForm.part_name || 'TOP'}
                    onChange={e => setBundleForm({ ...bundleForm, part_name: e.target.value })}
                  >
                    <option value="TOP">TOP (Shirt / T-Shirt / Body)</option>
                    <option value="BOTTOM">BOTTOM (Pants / Pyjama / Shorts)</option>
                    <option value="FOLDING">FOLDING (Waistband / Fold)</option>
                    <option value="COLLAR">COLLAR (Collar / Rib)</option>
                    <option value="FULL_SET">FULL SET (Combined)</option>
                    <option value="CUSTOM">CUSTOM PART...</option>
                  </select>
                </div>
                {bundleForm.part_name === 'CUSTOM' ? (
                  <Input
                    label="Custom Part Name *"
                    value={bundleForm.custom_part || ''}
                    onChange={e => setBundleForm({ ...bundleForm, custom_part: e.target.value })}
                    placeholder="e.g. SLEEVE / POCKET"
                  />
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">Selected Part Code</label>
                    <div className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold font-mono text-brand-700">
                      PART: {bundleForm.part_name || 'TOP'}
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input label="Total Cutting Qty (PCS)" type="number" value={bundleForm.total_qty}
                  onChange={e => setBundleForm({ ...bundleForm, total_qty: Number(e.target.value) })} />
                <Input label="Bundle Size (Pcs per bundle)" type="number" value={bundleForm.bundle_size}
                  onChange={e => setBundleForm({ ...bundleForm, bundle_size: Number(e.target.value) })} />
              </div>

              <div>
                <Input
                  label="Garment Components (Comma-separated)"
                  value={bundleForm.components}
                  onChange={e => setBundleForm({ ...bundleForm, components: e.target.value })}
                />
                <p className="text-[11px] text-slate-400 mt-1">Each bundle will create piece tickets for every listed component.</p>
              </div>

              <div className="p-3 bg-blue-50/70 border border-blue-100 rounded-lg text-xs text-blue-800 flex justify-between items-center">
                <span>
                  Will create <strong>{Math.ceil(bundleForm.total_qty / (bundleForm.bundle_size || 1))}</strong> bundles for <strong>Part: {bundleForm.part_name === 'CUSTOM' ? bundleForm.custom_part || 'CUSTOM' : bundleForm.part_name || 'TOP'}</strong>.
                </span>
                <span className="font-mono bg-blue-100 px-2 py-0.5 rounded text-[11px] font-bold">
                  B01 to B{String(Math.ceil(bundleForm.total_qty / (bundleForm.bundle_size || 1))).padStart(2, '0')}
                </span>
              </div>
            </div>

            )}

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowBundleModal(false)}>Cancel</Button>
              <Button onClick={genMode === 'OUTPUT' ? handleGenerateFromOutput : handleGenerateBundles} loading={saving}>Generate</Button>
            </div>
          </div>
        </div>
      )}

      {/* Print Barcode Tickets Modal */}
      {showPrintModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 overflow-y-auto">
          <div className="w-full max-w-4xl bg-white rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Print Bundle Barcode Tickets</h3>
                <p className="text-xs text-slate-500">
                  {printBundle ? `1 Ticket: ${printBundle.bundle_no}` : `${filteredBundles.length} Tickets for Part: ${selectedPartFilter}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={() => window.print()}>🖨️ Print Labels</Button>
                <button onClick={() => { setShowPrintModal(false); setPrintBundle(null); }} className="text-slate-400 hover:text-slate-600 font-bold text-lg">✕</button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-100/50">
              {(printBundle ? [printBundle] : filteredBundles).map((b: any, idx: number) => {
                const part = (b.part_name || 'TOP').toUpperCase();
                const partColor = part === 'BOTTOM' ? 'bg-emerald-600' : part === 'FOLDING' ? 'bg-purple-600' : part === 'COLLAR' ? 'bg-amber-600' : 'bg-blue-600';
                return (
                  <div key={b.id || idx} className="bg-white border-2 border-slate-300 rounded-xl p-4 shadow-sm flex flex-col justify-between">
                    <div>
                      {/* Top Header: Part Banner & Bundle Seq */}
                      <div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-3">
                        <span className={`px-3 py-1 rounded-md text-white font-black text-sm tracking-wider uppercase ${partColor}`}>
                          PART: {part}
                        </span>
                        <div className="text-right">
                          <span className="text-[10px] font-semibold text-slate-400 uppercase">BUNDLE NO</span>
                          <p className="text-lg font-black font-mono text-slate-900 leading-none">
                            {b.bundle_seq ? `#${String(b.bundle_seq).padStart(2, '0')} / ${b.total_bundles || '?'}` : b.bundle_no}
                          </p>
                        </div>
                      </div>

                      {/* Details Grid */}
                      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                        <div>
                          <span className="text-slate-400 font-medium">I/O Number:</span>
                          <p className="font-mono font-bold text-slate-800">{b.io_no}</p>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Style Code:</span>
                          <p className="font-bold text-slate-800">{b.style_code || 'N/A'}</p>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Colour:</span>
                          <p className="font-semibold text-slate-800">{b.color_name || 'N/A'}</p>
                        </div>
                        <div>
                          <span className="text-slate-400 font-medium">Size:</span>
                          <p className="font-bold text-slate-800">{b.size_code || 'N/A'}</p>
                        </div>
                      </div>

                      {/* Quantity Highlight */}
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-center mb-3">
                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Bundle Quantity</span>
                        <p className="text-2xl font-black text-blue-700">{b.qty} PCS</p>
                      </div>
                    </div>

                    {/* Barcode representation */}
                    <div className="border-t border-slate-200 pt-3 text-center">
                      <div className="font-mono tracking-widest text-lg font-bold bg-slate-100 py-1.5 px-3 rounded text-slate-800 select-all">
                        {b.barcode || b.bundle_no}
                      </div>
                      <p className="text-[10px] text-slate-400 font-mono mt-1">{b.bundle_no}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Record Cut QC Modal */}
      {showQcModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Record Cut Piece QC</h3>
              <button onClick={() => setShowQcModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Input label="Date" type="date" value={qcForm.qc_date}
                  onChange={e => setQcForm({ ...qcForm, qc_date: e.target.value })} />
                <Select
                  label="Cutting Record *"
                  value={qcForm.cutting_id}
                  onChange={e => {
                    const c = cuttings.find(item => String(item.id) === e.target.value);
                    setQcForm({ ...qcForm, cutting_id: e.target.value, io_no: c?.io_no || '' });
                  }}
                  options={[
                    { value: '', label: '— Select —' },
                    ...cuttings.map(c => ({ value: c.id, label: c.cut_no })),
                  ]}
                />
                <Input label="I/O No" value={qcForm.io_no} disabled />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Component" value={qcForm.component}
                  onChange={e => setQcForm({ ...qcForm, component: e.target.value })} placeholder="FRONT / BACK" />
                <Input label="Cut Qty" type="number" value={qcForm.cut_qty}
                  onChange={e => setQcForm({ ...qcForm, cut_qty: Number(e.target.value) })} />
                <Input label="Accepted Qty" type="number" value={qcForm.accepted_qty}
                  onChange={e => setQcForm({ ...qcForm, accepted_qty: Number(e.target.value) })} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Reject Qty" type="number" value={qcForm.reject_qty}
                  onChange={e => setQcForm({ ...qcForm, reject_qty: Number(e.target.value) })} />
                <Input label="Recut Qty" type="number" value={qcForm.recut_qty}
                  onChange={e => setQcForm({ ...qcForm, recut_qty: Number(e.target.value) })} />
                <Input label="Defect Reason" value={qcForm.reject_reason}
                  onChange={e => setQcForm({ ...qcForm, reject_reason: e.target.value })} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Select label="QC Status" value={qcForm.qc_status}
                  onChange={e => setQcForm({ ...qcForm, qc_status: e.target.value })}
                  options={[
                    { value: 'APPROVED', label: 'Approved' },
                    { value: 'REJECTED', label: 'Rejected' },
                    { value: 'CONDITIONAL', label: 'Conditional' },
                  ]} />
                <Input label="Inspector" value={qcForm.inspector_name}
                  onChange={e => setQcForm({ ...qcForm, inspector_name: e.target.value })} />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowQcModal(false)}>Cancel</Button>
              <Button onClick={handleSaveQc} loading={saving}>Save Cut QC</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
