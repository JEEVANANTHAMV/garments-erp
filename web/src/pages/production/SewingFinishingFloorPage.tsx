import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

export function SewingFinishingFloorPage() {
  const [activeTab, setActiveTab] = useState<'sewing' | 'finishing' | 'final_qc'>('sewing');
  const [sewingInputs, setSewingInputs] = useState<any[]>([]);
  const [bundles, setBundles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  // Sewing Modal
  const [showSewModal, setShowSewModal] = useState(false);
  const [sewForm, setSewForm] = useState<any>({
    input_date: today(),
    bundle_id: '',
    line_name: 'LINE-01',
    operator_name: '',
    remarks: '',
  });

  // Sewing Output Modal
  const [showSewOutModal, setShowSewOutModal] = useState(false);
  const [selectedSewInput, setSelectedSewInput] = useState<any>(null);
  const [sewOutForm, setSewOutForm] = useState<any>({
    output_date: today(),
    output_qty: 0,
    reject_qty: 0,
    rework_qty: 0,
    remarks: '',
  });

  // Final QC Modal
  const [showFinalQcModal, setShowFinalQcModal] = useState(false);
  const [finalQcForm, setFinalQcForm] = useState<any>({
    qc_date: today(),
    finishing_output_id: 1,
    inspected_qty: 100,
    passed_qty: 98,
    reject_qty: 2,
    rework_qty: 0,
    qc_status: 'PASS',
    inspector_name: '',
    remarks: '',
  });

  const [saving, setSaving] = useState(false);

  const fetchSewing = () => {
    setLoading(true);
    Promise.all([
      api.get('/sewing/inputs'),
      api.get('/bundles'),
    ]).then(([si, b]) => {
      setSewingInputs(si.data.data || []);
      setBundles(b.data.data || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSewing();
  }, []);

  const handleCreateSewingInput = async () => {
    if (!sewForm.bundle_id) {
      toast('Please select a bundle', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/sewing/input', {
        ...sewForm,
        bundle_id: Number(sewForm.bundle_id),
      });
      toast('Bundle taken into Sewing Line');
      setShowSewModal(false);
      fetchSewing();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Sewing input failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleRecordSewingOutput = async () => {
    if (!selectedSewInput) return;
    setSaving(true);
    try {
      await api.post('/sewing/output', {
        ...sewOutForm,
        sewing_input_id: selectedSewInput.id,
      });
      toast('Sewing output recorded');
      setShowSewOutModal(false);
      fetchSewing();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Output record failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveFinalQc = async () => {
    setSaving(true);
    try {
      await api.post('/final-qc', finalQcForm);
      toast('Final QC inspection passed!');
      setShowFinalQcModal(false);
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Final QC failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openOutputForInput = (inp: any) => {
    setSelectedSewInput(inp);
    setSewOutForm({
      output_date: today(),
      output_qty: inp.input_qty || 0,
      reject_qty: 0,
      rework_qty: 0,
      remarks: '',
    });
    setShowSewOutModal(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Sewing & Finishing Floor</h1>
          <p className="text-sm text-slate-500">Live line input, output, rework & Final QC inspection</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowFinalQcModal(true)}>+ Record Final QC</Button>
          <Button onClick={() => setShowSewModal(true)}>+ Sewing Input</Button>
        </div>
      </div>

      <div className="flex border-b border-slate-200 gap-6 text-sm font-medium">
        <button
          onClick={() => setActiveTab('sewing')}
          className={`pb-3 ${activeTab === 'sewing' ? 'border-b-2 border-brand-600 text-brand-700 font-bold' : 'text-slate-500'}`}
        >
          Sewing Inputs & Outputs ({sewingInputs.length})
        </button>
      </div>

      <Card>
        <DataTable
          data={sewingInputs}
          loading={loading}
          columns={[
            { key: 'input_no', header: 'Input No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-semibold text-brand-700">{r.input_no}</span> },
            { key: 'input_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.input_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
            { key: 'bundle_no', header: 'Bundle' },
            { key: 'style_code', header: 'Style' },
            { key: 'color_name', header: 'Colour' },
            { key: 'size_code', header: 'Size' },
            { key: 'line_name', header: 'Line', render: (r: any) => <Badge color="blue">{r.line_name}</Badge> },
            { key: 'input_qty', header: 'Input Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.input_qty) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={r.status === 'COMPLETED' ? 'emerald' : 'amber'}>{r.status}</Badge> },
            { key: 'actions', header: '', align: 'right' as const, render: (r: any) => (
              r.status !== 'COMPLETED' ? (
                <Button size="sm" variant="outline" onClick={() => openOutputForInput(r)}>
                  Record Output
                </Button>
              ) : <span className="text-xs text-emerald-600 font-medium">✓ Completed</span>
            ) },
          ]}
        />
      </Card>

      {/* Sewing Input Modal */}
      {showSewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Issue Bundle to Sewing Line</h3>
              <button onClick={() => setShowSewModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Date" type="date" value={sewForm.input_date}
                  onChange={e => setSewForm({ ...sewForm, input_date: e.target.value })} />
                <Select
                  label="Bundle to Input *"
                  value={sewForm.bundle_id}
                  onChange={e => setSewForm({ ...sewForm, bundle_id: e.target.value })}
                  options={[
                    { value: '', label: '— Select Available Bundle —' },
                    ...bundles.filter(b => b.status !== 'COMPLETED').map(b => ({
                      value: b.id,
                      label: `${b.bundle_no} (${b.qty} pcs, I/O: ${b.io_no || 'N/A'})`,
                    })),
                  ]}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input label="Sewing Line *" value={sewForm.line_name}
                  onChange={e => setSewForm({ ...sewForm, line_name: e.target.value })} placeholder="LINE-01" />
                <Input label="Operator / Supervisor" value={sewForm.operator_name}
                  onChange={e => setSewForm({ ...sewForm, operator_name: e.target.value })} />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowSewModal(false)}>Cancel</Button>
              <Button onClick={handleCreateSewingInput} loading={saving}>Input to Line</Button>
            </div>
          </div>
        </div>
      )}

      {/* Sewing Output Modal */}
      {showSewOutModal && selectedSewInput && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Record Sewing Output</h3>
                <p className="text-xs text-slate-500">Input #{selectedSewInput.input_no} | Bundle: {selectedSewInput.bundle_no}</p>
              </div>
              <button onClick={() => setShowSewOutModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Input label="Good Output Qty *" type="number" value={sewOutForm.output_qty}
                  onChange={e => setSewOutForm({ ...sewOutForm, output_qty: Number(e.target.value) })} />
                <Input label="Reject Qty" type="number" value={sewOutForm.reject_qty}
                  onChange={e => setSewOutForm({ ...sewOutForm, reject_qty: Number(e.target.value) })} />
                <Input label="Rework Qty" type="number" value={sewOutForm.rework_qty}
                  onChange={e => setSewOutForm({ ...sewOutForm, rework_qty: Number(e.target.value) })} />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowSewOutModal(false)}>Cancel</Button>
              <Button onClick={handleRecordSewingOutput} loading={saving}>Confirm Output</Button>
            </div>
          </div>
        </div>
      )}

      {/* Final QC Modal */}
      {showFinalQcModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Final QC Inspection</h3>
              <button onClick={() => setShowFinalQcModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Date" type="date" value={finalQcForm.qc_date}
                  onChange={e => setFinalQcForm({ ...finalQcForm, qc_date: e.target.value })} />
                <Select
                  label="QC Status"
                  value={finalQcForm.qc_status}
                  onChange={e => setFinalQcForm({ ...finalQcForm, qc_status: e.target.value })}
                  options={[
                    { value: 'PASS', label: 'Pass (Ready for FG)' },
                    { value: 'HOLD', label: 'Hold' },
                    { value: 'REJECT', label: 'Reject' },
                  ]}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Inspected Qty" type="number" value={finalQcForm.inspected_qty}
                  onChange={e => setFinalQcForm({ ...finalQcForm, inspected_qty: Number(e.target.value) })} />
                <Input label="Passed Qty" type="number" value={finalQcForm.passed_qty}
                  onChange={e => setFinalQcForm({ ...finalQcForm, passed_qty: Number(e.target.value) })} />
                <Input label="Reject Qty" type="number" value={finalQcForm.reject_qty}
                  onChange={e => setFinalQcForm({ ...finalQcForm, reject_qty: Number(e.target.value) })} />
              </div>

              <Input label="QC Inspector" value={finalQcForm.inspector_name}
                onChange={e => setFinalQcForm({ ...finalQcForm, inspector_name: e.target.value })} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowFinalQcModal(false)}>Cancel</Button>
              <Button onClick={handleSaveFinalQc} loading={saving}>Save Final QC</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
