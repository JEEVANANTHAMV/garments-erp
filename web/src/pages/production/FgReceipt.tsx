import { useState, useEffect } from 'react';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

export function FgReceiptsPage() {
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [styles, setStyles] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [colors, setColors] = useState<any[]>([]);
  const [sizes, setSizes] = useState<any[]>([]);
  const toast = useToast();

  const [header, setHeader] = useState<any>({
    receipt_no: '',
    receipt_date: today(),
    io_no: 'IO-2026-00125',
    style_id: '',
    warehouse_id: '',
    source_stage: 'FINISHING',
    status: 'RECEIVED',
    remarks: '',
  });

  const [lines, setLines] = useState<any[]>([
    { color_id: 1, size_id: 1, good_qty: 100, reject_qty: 0, batch_no: 'FG-B-001' },
  ]);
  const [saving, setSaving] = useState(false);

  const fetchReceipts = () => {
    setLoading(true);
    api.get('/fg-receipts')
      .then(r => setReceipts(r.data.data || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReceipts();
    Promise.all([
      api.get('/lookups/styles'),
      api.get('/lookups/warehouses'),
      api.get('/lookups/colors'),
      api.get('/lookups/sizes'),
    ]).then(([st, wh, col, sz]) => {
      setStyles(st.data.data || []);
      setWarehouses(wh.data.data || []);
      setColors(col.data.data || []);
      setSizes(sz.data.data || []);
    });
  }, []);

  const addLine = () => {
    setLines(prev => [
      ...prev,
      { color_id: colors[0]?.id || 1, size_id: sizes[0]?.id || 1, good_qty: 0, reject_qty: 0, batch_no: '' },
    ]);
  };

  const updateLine = (idx: number, field: string, val: any) => {
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, [field]: val } : l)));
  };

  const removeLine = (idx: number) => {
    setLines(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!header.style_id || !header.io_no) {
      toast('Please enter I/O No and select a Style', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.post('/fg-receipts', {
        ...header,
        style_id: Number(header.style_id),
        warehouse_id: header.warehouse_id ? Number(header.warehouse_id) : null,
        lines,
      });
      toast('FG Receipt created successfully');
      setShowModal(false);
      fetchReceipts();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to create FG receipt', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Finished Goods Receipts</h1>
          <p className="text-sm text-slate-500">Receive inspected finished garments into FG Warehouse with I/O and Style traceability</p>
        </div>
        <Button onClick={() => setShowModal(true)}>+ Receive Finished Goods</Button>
      </div>

      <Card>
        <DataTable
          data={receipts}
          loading={loading}
          columns={[
            { key: 'receipt_no', header: 'Receipt No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-semibold text-brand-700">{r.receipt_no}</span> },
            { key: 'receipt_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.receipt_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => <Badge variant="outline" color="indigo">{r.io_no}</Badge> },
            { key: 'style_code', header: 'Style', render: (r: any) => <span className="font-medium">{r.style_code}</span> },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'source_stage', header: 'Source', render: (r: any) => <Badge color="slate">{r.source_stage}</Badge> },
            { key: 'total_qty', header: 'Good Qty', align: 'right' as const, render: (r: any) => <span className="text-emerald-700 font-semibold">{fmtNumber(r.total_qty)}</span> },
            { key: 'total_reject', header: 'Reject Qty', align: 'right' as const, render: (r: any) => <span className="text-red-600 font-semibold">{fmtNumber(r.total_reject)}</span> },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={r.status === 'RECEIVED' ? 'emerald' : 'slate'}>{r.status}</Badge> },
          ]}
        />
      </Card>

      {/* Receive FG Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-3xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">New Finished Goods Receipt</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-3 gap-4">
                <Input label="Receipt Date" type="date" value={header.receipt_date}
                  onChange={e => setHeader({ ...header, receipt_date: e.target.value })} />
                <Input label="I/O Number *" value={header.io_no}
                  onChange={e => setHeader({ ...header, io_no: e.target.value })} placeholder="IO-2026-00125" />
                <Select
                  label="Target Style *"
                  value={header.style_id}
                  onChange={e => setHeader({ ...header, style_id: e.target.value })}
                  options={[
                    { value: '', label: '— Select Style —' },
                    ...styles.map(st => ({ value: st.id, label: `${st.style_code} (${st.style_name || ''})` })),
                  ]}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Select
                  label="FG Warehouse *"
                  value={header.warehouse_id}
                  onChange={e => setHeader({ ...header, warehouse_id: e.target.value })}
                  options={[
                    { value: '', label: '— Select FG Warehouse —' },
                    ...warehouses.map(w => ({ value: w.id, label: w.label || w.warehouse_name })),
                  ]}
                />
                <Input label="Source Stage" value={header.source_stage}
                  onChange={e => setHeader({ ...header, source_stage: e.target.value })} />
              </div>

              {/* Line Breakdown */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-800">Colour & Size Breakdown</h4>
                  <Button variant="outline" size="sm" onClick={addLine}>+ Add Line</Button>
                </div>

                <table className="w-full text-xs text-left border rounded-lg overflow-hidden">
                  <thead className="bg-slate-50 border-b">
                    <tr>
                      <th className="p-2">Colour</th>
                      <th className="p-2">Size</th>
                      <th className="p-2">Good Qty</th>
                      <th className="p-2">Reject Qty</th>
                      <th className="p-2">Batch No</th>
                      <th className="p-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={idx} className="border-b">
                        <td className="p-1.5">
                          <select className="w-full border rounded px-1.5 py-1" value={line.color_id}
                            onChange={e => updateLine(idx, 'color_id', Number(e.target.value))}>
                            {colors.map(c => <option key={c.id} value={c.id}>{c.label || c.color_name}</option>)}
                          </select>
                        </td>
                        <td className="p-1.5">
                          <select className="w-full border rounded px-1.5 py-1" value={line.size_id}
                            onChange={e => updateLine(idx, 'size_id', Number(e.target.value))}>
                            {sizes.map(s => <option key={s.id} value={s.id}>{s.label || s.size_code}</option>)}
                          </select>
                        </td>
                        <td className="p-1.5">
                          <input type="number" className="w-full border rounded px-1.5 py-1" value={line.good_qty}
                            onChange={e => updateLine(idx, 'good_qty', Number(e.target.value))} />
                        </td>
                        <td className="p-1.5">
                          <input type="number" className="w-full border rounded px-1.5 py-1" value={line.reject_qty}
                            onChange={e => updateLine(idx, 'reject_qty', Number(e.target.value))} />
                        </td>
                        <td className="p-1.5">
                          <input className="w-full border rounded px-1.5 py-1" value={line.batch_no}
                            onChange={e => updateLine(idx, 'batch_no', e.target.value)} placeholder="BATCH" />
                        </td>
                        <td className="p-1.5 text-center">
                          <button onClick={() => removeLine(idx)} className="text-red-500 font-bold">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Textarea label="Remarks" value={header.remarks} onChange={e => setHeader({ ...header, remarks: e.target.value })} rows={2} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button onClick={handleSave} loading={saving}>Save FG Receipt</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FgReceiptsPage;
