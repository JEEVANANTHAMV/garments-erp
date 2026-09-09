import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

export function LaySpreadingPage() {
  const [activeTab, setActiveTab] = useState<'lays' | 'spreading'>('lays');
  const [lays, setLays] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [cuttingPlans, setCuttingPlans] = useState<any[]>([]);
  const [showLayModal, setShowLayModal] = useState(false);
  const [showSpreadingModal, setShowSpreadingModal] = useState(false);
  const [selectedLay, setSelectedLay] = useState<any>(null);
  const toast = useToast();

  const [layForm, setLayForm] = useState<any>({
    lay_no: '',
    lay_date: today(),
    cutting_plan_id: '',
    marker_ref: 'MK-1025-01',
    marker_length_m: 8.5,
    ply_count: 50,
    shade: 'A',
    table_no: 'TBL-01',
    planned_cut_qty: 1000,
    status: 'PLANNED',
    remarks: '',
  });

  const [spreadingForm, setSpreadingForm] = useState<any>({
    spreading_no: '',
    spreading_date: today(),
    roll_no: 'R001',
    start_mtr: 100,
    end_mtr: 15,
    actual_used_mtr: 85,
    ply_count: 50,
    fabric_width_cm: 150,
    gsm: 180,
    shade: 'A',
    operator_name: '',
    qc_status: 'PASS',
    remarks: '',
  });

  const [saving, setSaving] = useState(false);

  const fetchLays = () => {
    setLoading(true);
    api.get('/lay-plans')
      .then(r => setLays(r.data.data || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLays();
    api.get('/cutting-plans').then(r => setCuttingPlans(r.data.data || []));
  }, []);

  const handleSaveLay = async () => {
    if (!layForm.cutting_plan_id) {
      toast('Please select a Cutting Plan', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/lay-plans', {
        ...layForm,
        cutting_plan_id: Number(layForm.cutting_plan_id),
      });
      toast('Lay Plan created successfully');
      setShowLayModal(false);
      fetchLays();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to create Lay Plan', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSpreading = async () => {
    if (!selectedLay) return;
    setSaving(true);
    try {
      await api.post(`/lay-plans/${selectedLay.id}/spreading`, spreadingForm);
      toast('Spreading details recorded');
      setShowSpreadingModal(false);
      fetchLays();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to record spreading', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openSpreadingForLay = (lay: any) => {
    setSelectedLay(lay);
    setSpreadingForm((prev: any) => ({
      ...prev,
      ply_count: lay.ply_count || 50,
      shade: lay.shade || 'A',
    }));
    setShowSpreadingModal(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Lay Planning & Spreading</h1>
          <p className="text-sm text-slate-500">Track planned vs actual fabric consumption, ply count, and roll QC</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setShowLayModal(true)}>+ New Lay Plan</Button>
        </div>
      </div>

      <div className="flex border-b border-slate-200 gap-6 text-sm font-medium">
        <button
          onClick={() => setActiveTab('lays')}
          className={`pb-3 ${activeTab === 'lays' ? 'border-b-2 border-brand-600 text-brand-700 font-bold' : 'text-slate-500'}`}
        >
          Lay Plans ({lays.length})
        </button>
      </div>

      <Card>
        <DataTable
          data={lays}
          loading={loading}
          columns={[
            { key: 'lay_no', header: 'Lay No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-semibold text-brand-700">{r.lay_no}</span> },
            { key: 'lay_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.lay_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
            { key: 'style_code', header: 'Style', render: (r: any) => <span className="font-medium">{r.style_code}</span> },
            { key: 'marker_ref', header: 'Marker Ref' },
            { key: 'marker_length_m', header: 'Length (M)', align: 'right' as const, render: (r: any) => fmtDecimal(r.marker_length_m) },
            { key: 'ply_count', header: 'Plies', align: 'right' as const, render: (r: any) => fmtNumber(r.ply_count) },
            { key: 'table_no', header: 'Table' },
            { key: 'status', header: 'Status', render: (r: any) => (
              <Badge color={r.status === 'SPREAD' ? 'blue' : r.status === 'CUT' ? 'emerald' : 'slate'}>{r.status}</Badge>
            ) },
            { key: 'actions', header: '', align: 'right' as const, render: (r: any) => (
              <Button size="sm" variant="outline" onClick={() => openSpreadingForLay(r)}>
                + Record Spreading
              </Button>
            ) },
          ]}
        />
      </Card>

      {/* New Lay Plan Modal */}
      {showLayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Create Lay Plan</h3>
              <button onClick={() => setShowLayModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Lay Date" type="date" value={layForm.lay_date}
                  onChange={e => setLayForm({ ...layForm, lay_date: e.target.value })} />
                
                <Select
                  label="Cutting Plan *"
                  value={layForm.cutting_plan_id}
                  onChange={e => setLayForm({ ...layForm, cutting_plan_id: e.target.value })}
                  options={[
                    { value: '', label: '— Select Cutting Plan —' },
                    ...cuttingPlans.map(cp => ({ value: cp.id, label: `${cp.plan_no} (I/O: ${cp.io_no})` })),
                  ]}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Marker Ref" value={layForm.marker_ref} onChange={e => setLayForm({ ...layForm, marker_ref: e.target.value })} />
                <Input label="Marker Length (M)" type="number" value={layForm.marker_length_m} onChange={e => setLayForm({ ...layForm, marker_length_m: Number(e.target.value) })} />
                <Input label="Ply Count" type="number" value={layForm.ply_count} onChange={e => setLayForm({ ...layForm, ply_count: Number(e.target.value) })} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Shade" value={layForm.shade} onChange={e => setLayForm({ ...layForm, shade: e.target.value })} />
                <Input label="Table No" value={layForm.table_no} onChange={e => setLayForm({ ...layForm, table_no: e.target.value })} />
                <Input label="Planned Cut Qty" type="number" value={layForm.planned_cut_qty} onChange={e => setLayForm({ ...layForm, planned_cut_qty: Number(e.target.value) })} />
              </div>

              <Textarea label="Remarks" value={layForm.remarks} onChange={e => setLayForm({ ...layForm, remarks: e.target.value })} rows={2} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowLayModal(false)}>Cancel</Button>
              <Button onClick={handleSaveLay} loading={saving}>Create Lay Plan</Button>
            </div>
          </div>
        </div>
      )}

      {/* Record Spreading Modal */}
      {showSpreadingModal && selectedLay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Record Spreading</h3>
                <p className="text-xs text-slate-500">Lay: {selectedLay.lay_no} | I/O: {selectedLay.io_no}</p>
              </div>
              <button onClick={() => setShowSpreadingModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Input label="Spreading Date" type="date" value={spreadingForm.spreading_date}
                  onChange={e => setSpreadingForm({ ...spreadingForm, spreading_date: e.target.value })} />
                <Input label="Roll No" value={spreadingForm.roll_no}
                  onChange={e => setSpreadingForm({ ...spreadingForm, roll_no: e.target.value })} />
                <Input label="Operator" value={spreadingForm.operator_name}
                  onChange={e => setSpreadingForm({ ...spreadingForm, operator_name: e.target.value })} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Start MTR" type="number" value={spreadingForm.start_mtr}
                  onChange={e => setSpreadingForm({ ...spreadingForm, start_mtr: Number(e.target.value) })} />
                <Input label="End MTR" type="number" value={spreadingForm.end_mtr}
                  onChange={e => setSpreadingForm({ ...spreadingForm, end_mtr: Number(e.target.value), actual_used_mtr: spreadingForm.start_mtr - Number(e.target.value) })} />
                <Input label="Actual Used MTR" type="number" value={spreadingForm.actual_used_mtr}
                  onChange={e => setSpreadingForm({ ...spreadingForm, actual_used_mtr: Number(e.target.value) })} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Actual Plies" type="number" value={spreadingForm.ply_count}
                  onChange={e => setSpreadingForm({ ...spreadingForm, ply_count: Number(e.target.value) })} />
                <Input label="Fabric Width (cm)" type="number" value={spreadingForm.fabric_width_cm}
                  onChange={e => setSpreadingForm({ ...spreadingForm, fabric_width_cm: Number(e.target.value) })} />
                <Input label="GSM" type="number" value={spreadingForm.gsm}
                  onChange={e => setSpreadingForm({ ...spreadingForm, gsm: Number(e.target.value) })} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input label="Shade Check" value={spreadingForm.shade}
                  onChange={e => setSpreadingForm({ ...spreadingForm, shade: e.target.value })} />
                <Select label="QC Status" value={spreadingForm.qc_status}
                  onChange={e => setSpreadingForm({ ...spreadingForm, qc_status: e.target.value })}
                  options={[
                    { value: 'PASS', label: 'Pass' },
                    { value: 'HOLD', label: 'Hold' },
                    { value: 'REJECT', label: 'Reject' },
                  ]} />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowSpreadingModal(false)}>Cancel</Button>
              <Button onClick={handleSaveSpreading} loading={saving}>Save Spreading</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
