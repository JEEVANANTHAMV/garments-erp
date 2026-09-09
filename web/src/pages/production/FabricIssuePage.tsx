import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

export function FabricIssuePage() {
  const [issues, setIssues] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [cuttingPlans, setCuttingPlans] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const toast = useToast();

  const [header, setHeader] = useState<any>({
    issue_no: '',
    issue_date: today(),
    cutting_plan_id: '',
    io_no: '',
    style_name: '',
    warehouse_id: '',
    status: 'ISSUED',
    remarks: '',
  });

  const [rolls, setRolls] = useState<any[]>([
    { lot_no: 'LOT001', roll_no: 'R001', shade: 'A', issue_mtr: 50, issue_kg: 22, gsm: 180, width_cm: 150 },
  ]);
  const [saving, setSaving] = useState(false);

  const fetchIssues = () => {
    setLoading(true);
    api.get('/fabric-issues')
      .then(r => setIssues(r.data.data || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchIssues();
    Promise.all([
      api.get('/cutting-plans'),
      api.get('/lookups/warehouses'),
    ]).then(([cp, wh]) => {
      setCuttingPlans(cp.data.data || []);
      setWarehouses(wh.data.data || []);
    });
  }, []);

  const handleCuttingPlanChange = (planId: string) => {
    const selected = cuttingPlans.find(p => String(p.id) === planId);
    setHeader((prev: any) => ({
      ...prev,
      cutting_plan_id: planId,
      io_no: selected?.io_no || '',
      style_name: selected ? `${selected.style_code} - ${selected.style_name || ''}` : '',
    }));
  };

  const addRoll = () => {
    setRolls(prev => [
      ...prev,
      { lot_no: '', roll_no: '', shade: '', issue_mtr: 0, issue_kg: 0, gsm: '', width_cm: '' },
    ]);
  };

  const updateRoll = (idx: number, field: string, val: any) => {
    setRolls(prev => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  };

  const removeRoll = (idx: number) => {
    setRolls(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!header.cutting_plan_id) {
      toast('Please select a Cutting Plan', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/fabric-issues', {
        ...header,
        cutting_plan_id: Number(header.cutting_plan_id),
        warehouse_id: header.warehouse_id ? Number(header.warehouse_id) : null,
        rolls,
      });
      toast('Fabric issue created successfully');
      setShowModal(false);
      fetchIssues();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to issue fabric', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Fabric Issues</h1>
          <p className="text-sm text-slate-500">Roll-level fabric issuance linked to Cutting Plans & I/O No.</p>
        </div>
        <Button onClick={() => setShowModal(true)}>+ Issue Fabric</Button>
      </div>

      <Card>
        <DataTable
          data={issues}
          loading={loading}
          columns={[
            { key: 'issue_no', header: 'Issue No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-semibold text-brand-700">{r.issue_no}</span> },
            { key: 'issue_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.issue_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
            { key: 'plan_no', header: 'Cutting Plan' },
            { key: 'style_code', header: 'Style', render: (r: any) => <span className="font-medium">{r.style_code}</span> },
            { key: 'fabric_name', header: 'Fabric' },
            { key: 'total_rolls', header: 'Rolls', align: 'right' as const, render: (r: any) => fmtNumber(r.total_rolls) },
            { key: 'total_mtr', header: 'Meters', align: 'right' as const, render: (r: any) => fmtDecimal(r.total_mtr) },
            { key: 'total_kg', header: 'Weight (KG)', align: 'right' as const, render: (r: any) => fmtDecimal(r.total_kg) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={r.status === 'ISSUED' ? 'emerald' : 'slate'}>{r.status}</Badge> },
          ]}
        />
      </Card>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 overflow-y-auto">
          <div className="w-full max-w-4xl bg-white rounded-xl shadow-xl overflow-hidden my-8">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Issue Fabric to Cutting Plan</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Input label="Issue Date" type="date" value={header.issue_date}
                  onChange={e => setHeader({ ...header, issue_date: e.target.value })} />
                
                <Select
                  label="Cutting Plan *"
                  value={header.cutting_plan_id}
                  onChange={e => handleCuttingPlanChange(e.target.value)}
                  options={[
                    { value: '', label: '— Select Cutting Plan —' },
                    ...cuttingPlans.map(cp => ({ value: cp.id, label: `${cp.plan_no} (I/O: ${cp.io_no})` })),
                  ]}
                />

                <Select
                  label="Warehouse"
                  value={header.warehouse_id}
                  onChange={e => setHeader({ ...header, warehouse_id: e.target.value })}
                  options={[
                    { value: '', label: '— Select Warehouse —' },
                    ...warehouses.map(w => ({ value: w.id, label: w.label || w.warehouse_name })),
                  ]}
                />
              </div>

              {/* Inherited Read-Only Indicators */}
              <div className="p-3 bg-indigo-50/70 border border-indigo-100 rounded-lg flex items-center justify-between">
                <div>
                  <span className="text-xs text-indigo-700 font-medium">Inherited I/O Reference: </span>
                  <span className="font-mono font-bold text-indigo-900">{header.io_no || 'None'}</span>
                </div>
                <div>
                  <span className="text-xs text-indigo-700 font-medium">Target Style: </span>
                  <span className="font-semibold text-indigo-900">{header.style_name || 'None'}</span>
                </div>
              </div>

              {/* Roll Details */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-800">Fabric Rolls</h4>
                  <Button variant="outline" size="sm" onClick={addRoll}>+ Add Roll</Button>
                </div>

                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 border-b text-slate-600">
                      <tr>
                        <th className="p-2">Lot No</th>
                        <th className="p-2">Roll No</th>
                        <th className="p-2">Shade</th>
                        <th className="p-2">Meters</th>
                        <th className="p-2">Weight (KG)</th>
                        <th className="p-2">GSM</th>
                        <th className="p-2">Width (cm)</th>
                        <th className="p-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rolls.map((r, idx) => (
                        <tr key={idx} className="border-b">
                          <td className="p-1.5"><input className="w-full border rounded px-1.5 py-1" value={r.lot_no} onChange={e => updateRoll(idx, 'lot_no', e.target.value)} placeholder="LOT" /></td>
                          <td className="p-1.5"><input className="w-full border rounded px-1.5 py-1" value={r.roll_no} onChange={e => updateRoll(idx, 'roll_no', e.target.value)} placeholder="R-001" /></td>
                          <td className="p-1.5"><input className="w-full border rounded px-1.5 py-1" value={r.shade} onChange={e => updateRoll(idx, 'shade', e.target.value)} placeholder="A" /></td>
                          <td className="p-1.5"><input type="number" className="w-full border rounded px-1.5 py-1" value={r.issue_mtr} onChange={e => updateRoll(idx, 'issue_mtr', Number(e.target.value))} /></td>
                          <td className="p-1.5"><input type="number" className="w-full border rounded px-1.5 py-1" value={r.issue_kg} onChange={e => updateRoll(idx, 'issue_kg', Number(e.target.value))} /></td>
                          <td className="p-1.5"><input type="number" className="w-full border rounded px-1.5 py-1" value={r.gsm} onChange={e => updateRoll(idx, 'gsm', e.target.value)} placeholder="GSM" /></td>
                          <td className="p-1.5"><input type="number" className="w-full border rounded px-1.5 py-1" value={r.width_cm} onChange={e => updateRoll(idx, 'width_cm', e.target.value)} placeholder="Width" /></td>
                          <td className="p-1.5 text-center">
                            <button onClick={() => removeRoll(idx)} className="text-red-500 hover:text-red-700 font-bold">×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <Textarea label="Remarks" value={header.remarks} onChange={e => setHeader({ ...header, remarks: e.target.value })} rows={2} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button onClick={handleSave} loading={saving}>Issue Fabric</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
