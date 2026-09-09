import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

export function CutQcBundlesPage() {
  const [activeTab, setActiveTab] = useState<'bundles' | 'cut_qc' | 'scanner'>('bundles');
  const [bundles, setBundles] = useState<any[]>([]);
  const [cutQcs, setCutQcs] = useState<any[]>([]);
  const [cuttings, setCuttings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  // New Bundle Generator Form
  const [showBundleModal, setShowBundleModal] = useState(false);
  const [bundleForm, setBundleForm] = useState<any>({
    cutting_id: '',
    io_no: '',
    style_id: '',
    color_id: '',
    size_id: '',
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
      api.get('/resources/cuttings'),
    ]).then(([b, q, c]) => {
      setBundles(b.data.data || []);
      setCutQcs(q.data.data || []);
      setCuttings(c.data.data || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAll();
  }, []);

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
      await api.post('/bundles/generate-detailed', {
        ...bundleForm,
        cutting_id: Number(bundleForm.cutting_id),
        style_id: Number(bundleForm.style_id),
        color_id: Number(bundleForm.color_id),
        size_id: Number(bundleForm.size_id),
        components,
      });
      toast('Bundles generated with component barcodes!');
      setShowBundleModal(false);
      fetchAll();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to generate bundles', 'error');
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
      toast(e?.response?.data?.error?.message || 'Failed to record QC', 'error');
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
      toast(e?.response?.data?.error?.message || 'Bundle barcode not found', 'error');
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
      toast(e?.response?.data?.error?.message || 'Move failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cut Piece QC & Bundles</h1>
          <p className="text-sm text-slate-500">Component QC, barcode bundle generation, and floor stage movement</p>
        </div>
        <div className="flex gap-2">
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
          <DataTable
            data={bundles}
            loading={loading}
            columns={[
              { key: 'bundle_no', header: 'Bundle No', sortable: true, render: (r: any) => (
                <div>
                  <span className="font-mono text-xs font-bold text-brand-700">{r.bundle_no}</span>
                  {r.barcode && <p className="font-mono text-[10px] text-slate-400">{r.barcode}</p>}
                </div>
              ) },
              { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
              { key: 'style_code', header: 'Style' },
              { key: 'color_name', header: 'Colour' },
              { key: 'size_code', header: 'Size' },
              { key: 'qty', header: 'Qty (Pcs)', align: 'right' as const, render: (r: any) => <span className="font-semibold text-blue-700">{fmtNumber(r.qty)}</span> },
              { key: 'status', header: 'Stage', render: (r: any) => {
                const colors: Record<string, string> = {
                  GENERATED: 'slate', CHECKED: 'blue', ISSUED: 'indigo',
                  IN_SEWING: 'amber', COMPLETED: 'emerald', FINISHING: 'violet', CLOSED: 'gray',
                };
                return <Badge color={colors[r.status] || 'slate'}>{r.status}</Badge>;
              } },
              { key: 'actions', header: 'Move', align: 'right' as const, render: (r: any) => (
                <div className="flex justify-end gap-1">
                  {r.status === 'GENERATED' && (
                    <Button size="sm" variant="outline" onClick={() => handleMoveBundle(r.id, 'CHECKED')}>Verify</Button>
                  )}
                  {r.status === 'CHECKED' && (
                    <Button size="sm" variant="outline" onClick={() => handleMoveBundle(r.id, 'ISSUED')}>Issue</Button>
                  )}
                  {r.status === 'ISSUED' && (
                    <Button size="sm" variant="outline" onClick={() => handleMoveBundle(r.id, 'IN_SEWING')}>To Sewing</Button>
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
                <div className="grid grid-cols-3 gap-4 p-4 bg-slate-50 rounded-lg">
                  <div>
                    <span className="text-xs text-slate-500">I/O Number</span>
                    <p className="font-mono font-bold text-slate-800">{scannedBundle.io_no}</p>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">Style / Colour / Size</span>
                    <p className="font-semibold text-slate-800">{scannedBundle.style_code} | {scannedBundle.color_name} | {scannedBundle.size_code}</p>
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
                    {['CHECKED','ISSUED','IN_SEWING','COMPLETED','FINISHING','CLOSED'].map(stage => (
                      <Button
                        key={stage}
                        size="sm"
                        variant={scannedBundle.status === stage ? 'primary' : 'outline'}
                        onClick={() => handleMoveBundle(scannedBundle.id, stage)}
                      >
                        → {stage}
                      </Button>
                    ))}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Generate Cut Bundles</h3>
              <button onClick={() => setShowBundleModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

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

              <div className="grid grid-cols-2 gap-4">
                <Input label="Total Cutting Qty" type="number" value={bundleForm.total_qty}
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

              <div className="p-3 bg-blue-50/70 border border-blue-100 rounded-lg text-xs text-blue-800">
                Will create <strong>{Math.ceil(bundleForm.total_qty / (bundleForm.bundle_size || 1))}</strong> bundles with barcode format <span className="font-mono">{bundleForm.io_no || 'IO'}-ST-COL-SZ-B001</span>.
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowBundleModal(false)}>Cancel</Button>
              <Button onClick={handleGenerateBundles} loading={saving}>Generate</Button>
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
