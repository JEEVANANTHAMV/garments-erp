import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/* ============================================================
   CUTTING PLANS LIST
============================================================ */
export function CuttingPlansPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/cutting-plans').then(r => setPlans(r.data.data)).finally(() => setLoading(false));
  }, []);

  const statusColor = (s: string) => {
    const map: Record<string, string> = {
      DRAFT: 'slate', APPROVED: 'blue', RELEASED: 'indigo', IN_PROGRESS: 'amber',
      COMPLETED: 'emerald', CLOSED: 'gray', CANCELLED: 'red',
    };
    return map[s] || 'slate';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cutting Plans</h1>
          <p className="text-sm text-slate-500">I/O → Style → Size-wise cutting plans</p>
        </div>
        <Button onClick={() => nav('/production/cutting-plans/new')}>+ New Cutting Plan</Button>
      </div>

      <Card>
        <DataTable
          data={plans}
          loading={loading}
          columns={[
            { key: 'plan_no', header: 'Plan No', sortable: true,
              render: (r: any) => (
                <button onClick={() => nav(`/production/cutting-plans/${r.id}`)}
                  className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                  {r.plan_no}
                </button>
              ) },
            { key: 'plan_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.plan_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => (
              <Badge variant="outline" color="indigo">{r.io_no}</Badge>
            ) },
            { key: 'style_code', header: 'Style', render: (r: any) => (
              <div><p className="font-medium">{r.style_code}</p>
                <p className="text-[11px] text-slate-500">{r.style_name}</p></div>
            ) },
            { key: 'color_name', header: 'Colour' },
            { key: 'order_qty', header: 'Order Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.order_qty) },
            { key: 'planned_cut_qty', header: 'Planned', align: 'right' as const,
              render: (r: any) => <span className="font-medium text-blue-700">{fmtNumber(r.planned_cut_qty)}</span> },
            { key: 'actual_cut_qty', header: 'Actual', align: 'right' as const,
              render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.actual_cut_qty)}</span> },
            { key: 'status', header: 'Status', render: (r: any) => (
              <Badge color={statusColor(r.status)}>{r.status}</Badge>
            ) },
            { key: 'so_no', header: 'Sales Order' },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   CUTTING PLAN DETAIL (CREATE / EDIT)
============================================================ */
export function CuttingPlanDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    plan_no: '', plan_date: today(), io_no: '', so_id: null, prod_order_id: null,
    style_id: null, color_id: null, order_qty: 0, planned_cut_qty: 0,
    required_date: '', marker_ref: '', marker_eff_pct: '', fabric_id: null,
    fabric_req_kg: '', fabric_req_mtr: '', status: 'DRAFT', remarks: '',
  });
  const [sizes, setSizes] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  // Lookups
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [prodOrders, setProdOrders] = useState<any[]>([]);
  const [styles, setStyles] = useState<any[]>([]);
  const [colors, setColors] = useState<any[]>([]);
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [availSizes, setAvailSizes] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/lookups/production-orders'),
      api.get('/lookups/styles'),
      api.get('/lookups/colors'),
      api.get('/lookups/fabrics'),
      api.get('/lookups/sizes'),
    ]).then(([so, po, st, col, fab, sz]) => {
      setSalesOrders(so.data.data || []);
      setProdOrders(po.data.data || []);
      setStyles(st.data.data || []);
      setColors(col.data.data || []);
      setFabrics(fab.data.data || []);
      setAvailSizes(sz.data.data || []);
    });
  }, []);

  useEffect(() => {
    if (!isNew) {
      api.get(`/cutting-plans/${id}`).then(r => {
        const d = r.data.data;
        setHeader({
          plan_no: d.plan_no || '', plan_date: d.plan_date?.slice(0, 10) || today(),
          io_no: d.io_no || '', so_id: d.so_id, prod_order_id: d.prod_order_id,
          style_id: d.style_id, color_id: d.color_id,
          order_qty: d.order_qty || 0, planned_cut_qty: d.planned_cut_qty || 0,
          required_date: d.required_date?.slice(0, 10) || '',
          marker_ref: d.marker_ref || '', marker_eff_pct: d.marker_eff_pct || '',
          fabric_id: d.fabric_id, fabric_req_kg: d.fabric_req_kg || '',
          fabric_req_mtr: d.fabric_req_mtr || '', status: d.status || 'DRAFT',
          remarks: d.remarks || '',
        });
        setSizes(d.sizes || []);
      });
    }
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const addSizeLine = () => {
    setSizes(prev => [...prev, { size_id: null, sku_id: null, order_qty: 0, planned_qty: 0 }]);
  };

  const updateSize = (idx: number, k: string, v: any) => {
    setSizes(prev => prev.map((s, i) => i === idx ? { ...s, [k]: v } : s));
  };

  const removeSize = (idx: number) => {
    setSizes(prev => prev.filter((_, i) => i !== idx));
  };

  const toast = useToast();

  const handleSave = async () => {
    if (!header.io_no || !header.style_id) {
      toast('I/O No and Style are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...header, sizes };
      if (isNew) {
        const r = await api.post('/cutting-plans', payload);
        toast('Cutting plan created');
        nav(`/production/cutting-plans/${r.data.data.id}`);
      } else {
        await api.put(`/cutting-plans/${id}`, payload);
        toast('Cutting plan updated');
      }
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const STATUSES = ['DRAFT','APPROVED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED'];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Cutting Plan' : `Cutting Plan — ${header.plan_no}`}
          </h1>
          <p className="text-sm text-slate-500">I/O + Style traceability from cutting to packing</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/production/cutting-plans')}>← Back</Button>
          <Button onClick={handleSave} loading={saving}>Save</Button>
        </div>
      </div>

      {/* Header Fields */}
      <Card title="Plan Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Input label="Plan No" value={header.plan_no} onChange={e => setField('plan_no', e.target.value)}
            placeholder="Auto-generate" />
          <Input label="Plan Date" type="date" value={header.plan_date}
            onChange={e => setField('plan_date', e.target.value)} required />
          <Input label="I/O No" value={header.io_no} onChange={e => setField('io_no', e.target.value)}
            required placeholder="e.g. IO-2026-00125" />

          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => setField('so_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Production Order" value={header.prod_order_id || ''}
            onChange={e => setField('prod_order_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...prodOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Style" value={header.style_id || ''}
            onChange={e => setField('style_id', e.target.value ? Number(e.target.value) : null)} required
            options={[{ value: '', label: '— Select —' }, ...styles.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />

          <Select label="Colour" value={header.color_id || ''}
            onChange={e => setField('color_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— All Colours —' }, ...colors.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Status" value={header.status}
            onChange={e => setField('status', e.target.value)}
            options={STATUSES.map(s => ({ value: s, label: s }))} />
          <Input label="Required Date" type="date" value={header.required_date}
            onChange={e => setField('required_date', e.target.value)} />
        </div>
      </Card>

      {/* Quantities & Fabric */}
      <Card title="Quantities & Fabric">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4">
          <Input label="Order Qty" type="number" value={header.order_qty}
            onChange={e => setField('order_qty', Number(e.target.value))} />
          <Input label="Planned Cut Qty" type="number" value={header.planned_cut_qty}
            onChange={e => setField('planned_cut_qty', Number(e.target.value))} />
          <Input label="Marker Ref" value={header.marker_ref}
            onChange={e => setField('marker_ref', e.target.value)} />
          <Input label="Marker Eff %" type="number" value={header.marker_eff_pct}
            onChange={e => setField('marker_eff_pct', e.target.value)} />

          <Select label="Fabric" value={header.fabric_id || ''}
            onChange={e => setField('fabric_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...fabrics.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Input label="Fabric Req (KG)" type="number" value={header.fabric_req_kg}
            onChange={e => setField('fabric_req_kg', e.target.value)} />
          <Input label="Fabric Req (MTR)" type="number" value={header.fabric_req_mtr}
            onChange={e => setField('fabric_req_mtr', e.target.value)} />
        </div>
        <div className="px-4 pb-4">
          <Textarea label="Remarks" value={header.remarks} rows={2}
            onChange={e => setField('remarks', e.target.value)} />
        </div>
      </Card>

      {/* Size Breakdown */}
      <Card title="Size-wise Breakdown">
        <div className="p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="pb-2 pr-3">Size</th>
                <th className="pb-2 pr-3 text-right">Order Qty</th>
                <th className="pb-2 pr-3 text-right">Planned Qty</th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((sz, idx) => (
                <tr key={idx} className="border-b border-slate-100">
                  <td className="py-2 pr-3">
                    <Select value={sz.size_id || ''}
                      onChange={e => updateSize(idx, 'size_id', e.target.value ? Number(e.target.value) : null)}
                      options={[{ value: '', label: '— Size —' }, ...availSizes.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
                  </td>
                  <td className="py-2 pr-3">
                    <Input type="number" value={sz.order_qty}
                      onChange={e => updateSize(idx, 'order_qty', Number(e.target.value))}
                      className="text-right" />
                  </td>
                  <td className="py-2 pr-3">
                    <Input type="number" value={sz.planned_qty}
                      onChange={e => updateSize(idx, 'planned_qty', Number(e.target.value))}
                      className="text-right" />
                  </td>
                  <td className="py-2">
                    <button onClick={() => removeSize(idx)}
                      className="text-red-500 hover:text-red-700 text-xs">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="pt-3">
                  <Button variant="ghost" size="sm" onClick={addSizeLine}>+ Add Size</Button>
                </td>
              </tr>
              {sizes.length > 0 && (
                <tr className="border-t font-semibold">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right">{fmtNumber(sizes.reduce((s, l) => s + (l.order_qty || 0), 0))}</td>
                  <td className="pt-2 text-right">{fmtNumber(sizes.reduce((s, l) => s + (l.planned_qty || 0), 0))}</td>
                  <td></td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

export default CuttingPlansPage;
