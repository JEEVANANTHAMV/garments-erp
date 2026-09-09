import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/* ============================================================
   1. PACKING LISTS PAGE
============================================================ */
export function PackingListPage() {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/packing-lists').then(r => setLists(r.data.data)).finally(() => setLoading(false));
  }, []);

  const statusColor = (s: string) => ({ DRAFT: 'slate', CONFIRMED: 'emerald', CLOSED: 'gray' }[s] || 'slate');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Packing Lists</h1>
          <p className="text-sm text-slate-500">Frozen carton contents, weights, CBM, and I/O traceability</p>
        </div>
        <Button onClick={() => nav('/logistics/packing-lists/new')}>+ New Packing List</Button>
      </div>

      <Card>
        <DataTable
          data={lists}
          loading={loading}
          columns={[
            { key: 'pl_no', header: 'PL No', sortable: true,
              render: (r: any) => (
                <button onClick={() => nav(`/logistics/packing-lists/${r.id}`)}
                  className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                  {r.pl_no}
                </button>
              ) },
            { key: 'pl_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.pl_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => r.io_no ? <Badge variant="outline" color="indigo">{r.io_no}</Badge> : '—' },
            { key: 'so_no', header: 'Sales Order' },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'shipment_type', header: 'Type', render: (r: any) => (
              <Badge color={r.shipment_type === 'EXPORT' ? 'blue' : 'slate'}>{r.shipment_type}</Badge>
            ) },
            { key: 'total_cartons', header: 'Cartons', align: 'right' as const, render: (r: any) => fmtNumber(r.total_cartons) },
            { key: 'total_qty', header: 'Qty (Pcs)', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'gross_weight_kg', header: 'Gross (KG)', align: 'right' as const, render: (r: any) => fmtDecimal(r.gross_weight_kg) },
            { key: 'total_cbm', header: 'CBM', align: 'right' as const, render: (r: any) => fmtDecimal(r.total_cbm, 3) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={statusColor(r.status)}>{r.status}</Badge> },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   2. PACKING LIST DETAIL
============================================================ */
export function PackingListDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    pl_no: '', pl_date: today(), io_no: '', so_id: null, packing_id: null,
    invoice_id: null, buyer_id: null, consignee_id: null,
    shipment_type: 'DOMESTIC', destination: '', status: 'DRAFT',
  });
  const [cartons, setCartons] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  // Lookups
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [packings, setPackings] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/lookups/packings'),
      api.get('/lookups/parties'),
    ]).then(([so, pk, pt]) => {
      setSalesOrders(so.data.data || []);
      setPackings(pk.data.data || []);
      setBuyers(pt.data.data || []);
    });
  }, []);

  useEffect(() => {
    if (!isNew) {
      api.get(`/packing-lists/${id}`).then(r => {
        const d = r.data.data;
        setHeader({
          pl_no: d.pl_no || '', pl_date: d.pl_date?.slice(0, 10) || today(),
          io_no: d.io_no || '', so_id: d.so_id, packing_id: d.packing_id,
          invoice_id: d.invoice_id, buyer_id: d.buyer_id, consignee_id: d.consignee_id,
          shipment_type: d.shipment_type || 'DOMESTIC', destination: d.destination || '',
          status: d.status || 'DRAFT',
          total_cartons: d.total_cartons, total_qty: d.total_qty,
          net_weight_kg: d.net_weight_kg, gross_weight_kg: d.gross_weight_kg,
          total_cbm: d.total_cbm,
        });
        setCartons(d.cartons || []);
        setSummary(d.summary || []);
      });
    }
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const handlePackingSelect = (packingIdVal: string) => {
    const pId = packingIdVal ? Number(packingIdVal) : null;
    const p = packings.find(pk => pk.id === pId);
    setHeader((prev: any) => ({
      ...prev,
      packing_id: pId,
      io_no: p?.io_no || prev.io_no,
      so_id: p?.so_id || prev.so_id,
      buyer_id: p?.buyer_id || prev.buyer_id,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post('/packing-lists', header);
        toast('Packing list created');
        nav(`/logistics/packing-lists/${r.data.data.id}`);
      } else {
        toast('Packing list saved');
      }
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = async () => {
    try {
      await api.post(`/packing-lists/${id}/confirm`);
      toast('Packing list confirmed and frozen');
      setHeader((p: any) => ({ ...p, status: 'CONFIRMED' }));
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Confirm failed', 'error');
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Packing List' : `Packing List — ${header.pl_no}`}
          </h1>
          <p className="text-sm text-slate-500">Frozen package details for domestic/export transport</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/packing-lists')}>← Back</Button>
          {!isNew && header.status === 'DRAFT' && (
            <Button variant="outline" onClick={handleConfirm}>✓ Confirm & Freeze</Button>
          )}
          {(isNew || header.status === 'DRAFT') && (
            <Button onClick={handleSave} loading={saving}>Save</Button>
          )}
        </div>
      </div>

      {!isNew && (
        <div className="flex gap-3">
          <Badge color={header.status === 'CONFIRMED' ? 'emerald' : 'slate'} size="lg">
            {header.status}
          </Badge>
          {header.shipment_type === 'EXPORT' && <Badge color="blue" size="lg">EXPORT</Badge>}
        </div>
      )}

      {/* Header */}
      <Card title="Packing List Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Input label="PL No" value={header.pl_no} onChange={e => setField('pl_no', e.target.value)}
            placeholder="Auto-generate" disabled={!isNew} />
          <Input label="Date" type="date" value={header.pl_date}
            onChange={e => setField('pl_date', e.target.value)} />
          <div>
            <Input label="I/O No" value={header.io_no || ''} onChange={e => setField('io_no', e.target.value)}
              disabled={Boolean(header.packing_id)} />
            {header.packing_id && <span className="text-[10px] text-indigo-600 font-medium">🔒 Inherited from Packing</span>}
          </div>

          <Select label="Source Packing *" value={header.packing_id || ''}
            onChange={e => handlePackingSelect(e.target.value)}
            options={[{ value: '', label: '— Select Packing Transaction —' }, ...packings.map((s: any) => ({ value: s.id, label: `${s.label || s.code} (I/O: ${s.io_no || 'N/A'})` }))]} />
          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => setField('so_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Buyer" value={header.buyer_id || ''}
            onChange={e => setField('buyer_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />

          <Select label="Shipment Type" value={header.shipment_type}
            onChange={e => setField('shipment_type', e.target.value)}
            options={[{ value: 'DOMESTIC', label: 'Domestic' }, { value: 'EXPORT', label: 'Export' }]} />
          <Input label="Destination" value={header.destination} onChange={e => setField('destination', e.target.value)} />
        </div>
      </Card>

      {!isNew && (
        <Card title="Derived Totals">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4 text-center">
            <div>
              <p className="text-2xl font-bold text-slate-800">{fmtNumber(header.total_cartons)}</p>
              <p className="text-xs text-slate-500">Total Cartons</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-700">{fmtNumber(header.total_qty)}</p>
              <p className="text-xs text-slate-500">Total Quantity</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.net_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Net Weight</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.gross_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Gross Weight</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.total_cbm, 3)}</p>
              <p className="text-xs text-slate-500">Total CBM</p>
            </div>
          </div>
        </Card>
      )}

      {cartons.length > 0 && (
        <Card title={`Package Content Breakdown (${cartons.length} cartons)`}>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead className="border-b text-slate-500">
                <tr>
                  <th className="pb-2 text-left">Carton No</th>
                  <th className="pb-2 text-left">Type</th>
                  <th className="pb-2 text-left">Size Breakdown</th>
                  <th className="pb-2 text-right">Net Wt</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                </tr>
              </thead>
              <tbody>
                {cartons.map((c: any) => (
                  <tr key={c.id} className="border-b border-slate-50">
                    <td className="py-1.5 font-mono text-xs font-semibold">{c.carton_no}</td>
                    <td className="py-1.5">{c.carton_type || 'CARTON'}</td>
                    <td className="py-1.5 text-xs text-slate-600">{c.size_summary || '—'}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(c.net_weight_kg)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(c.gross_weight_kg)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(c.cbm, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {summary.length > 0 && (
        <Card title="Summary by Color & Size">
          <div className="p-4">
            <table className="w-full text-sm">
              <thead className="border-b text-slate-500">
                <tr>
                  <th className="pb-2 text-left">Color</th>
                  <th className="pb-2 text-left">Size</th>
                  <th className="pb-2 text-right">Total Qty (Pcs)</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s: any, idx: number) => (
                  <tr key={idx} className="border-b border-slate-50">
                    <td className="py-2 font-medium">{s.color_name || '-'}</td>
                    <td className="py-2">{s.size_code || '-'}</td>
                    <td className="py-2 text-right font-bold text-blue-700">{fmtNumber(s.total_qty)}</td>
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

/* ============================================================
   3. SHIPMENT PLANNING PAGE
============================================================ */
export function ShipmentPlanPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [availablePkgs, setAvailablePkgs] = useState<any[]>([]);
  const [selectedPkgs, setSelectedPkgs] = useState<number[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const nav = useNavigate();

  const [form, setForm] = useState<any>({
    planned_date: today(),
    buyer_id: '',
    shipment_type: 'DOMESTIC',
    mode: 'ROAD',
    destination: '',
    remarks: '',
  });

  const fetchPlans = () => {
    setLoading(true);
    api.get('/shipment-plans')
      .then(r => setPlans(r.data.data || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchPlans();
    Promise.all([
      api.get('/available-packages'),
      api.get('/lookups/parties'),
    ]).then(([pk, pt]) => {
      setAvailablePkgs(pk.data.data || []);
      setBuyers(pt.data.data || []);
    });
  }, []);

  const handleCreatePlan = async () => {
    setSaving(true);
    try {
      await api.post('/shipment-plans', {
        ...form,
        buyer_id: form.buyer_id ? Number(form.buyer_id) : null,
        package_ids: selectedPkgs,
      });
      toast('Shipment plan created');
      setShowModal(false);
      fetchPlans();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Plan creation failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConvert = async (planId: number) => {
    try {
      const r = await api.post(`/shipment-plans/${planId}/convert`);
      toast('Converted to Draft Shipment!');
      nav(`/logistics/shipments/${r.data.data.id}`);
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Conversion failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Shipment Planning</h1>
          <p className="text-sm text-slate-500">Plan and reserve confirmed packages for domestic and export shipping</p>
        </div>
        <Button onClick={() => setShowModal(true)}>+ New Shipment Plan</Button>
      </div>

      <Card>
        <DataTable
          data={plans}
          loading={loading}
          columns={[
            { key: 'plan_no', header: 'Plan No', sortable: true, render: (r: any) => <span className="font-mono text-xs font-bold text-brand-700">{r.plan_no}</span> },
            { key: 'planned_date', header: 'Planned Date', sortable: true, render: (r: any) => fmtDate(r.planned_date) },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'shipment_type', header: 'Type', render: (r: any) => <Badge color={r.shipment_type === 'EXPORT' ? 'blue' : 'slate'}>{r.shipment_type}</Badge> },
            { key: 'mode', header: 'Mode', render: (r: any) => <Badge variant="outline">{r.mode}</Badge> },
            { key: 'total_packages', header: 'Packages', align: 'right' as const, render: (r: any) => fmtNumber(r.total_packages) },
            { key: 'total_qty', header: 'Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={r.status === 'CONVERTED' ? 'emerald' : 'amber'}>{r.status}</Badge> },
            { key: 'actions', header: '', align: 'right' as const, render: (r: any) => (
              r.status !== 'CONVERTED' ? (
                <Button size="sm" onClick={() => handleConvert(r.id)}>Convert to Shipment →</Button>
              ) : <span className="text-xs text-emerald-600 font-medium">✓ Converted</span>
            ) },
          ]}
        />
      </Card>

      {/* Plan Creation Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-3xl bg-white rounded-xl shadow-xl overflow-hidden max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">New Shipment Plan</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-3 gap-4">
                <Input label="Planned Date" type="date" value={form.planned_date}
                  onChange={e => setForm({ ...form, planned_date: e.target.value })} />
                <Select label="Buyer" value={form.buyer_id}
                  onChange={e => setForm({ ...form, buyer_id: e.target.value })}
                  options={[{ value: '', label: '— Select —' }, ...buyers.map(b => ({ value: b.id, label: b.label || b.code }))]} />
                <Select label="Shipment Type" value={form.shipment_type}
                  onChange={e => setForm({ ...form, shipment_type: e.target.value })}
                  options={[{ value: 'DOMESTIC', label: 'Domestic' }, { value: 'EXPORT', label: 'Export' }]} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Select label="Mode" value={form.mode}
                  onChange={e => setForm({ ...form, mode: e.target.value })}
                  options={['ROAD','AIR','SEA','COURIER'].map(m => ({ value: m, label: m }))} />
                <Input label="Destination" value={form.destination}
                  onChange={e => setForm({ ...form, destination: e.target.value })} />
              </div>

              <div>
                <h4 className="text-sm font-semibold text-slate-800 mb-2">Select Confirmed Packages ({selectedPkgs.length} selected)</h4>
                <div className="border rounded-lg max-h-48 overflow-y-auto p-2 divide-y">
                  {availablePkgs.map(p => (
                    <label key={p.id} className="flex items-center gap-3 p-2 hover:bg-slate-50 cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={selectedPkgs.includes(p.id)}
                        onChange={e => setSelectedPkgs(prev => e.target.checked ? [...prev, p.id] : prev.filter(i => i !== p.id))}
                      />
                      <span className="font-mono font-semibold">{p.carton_no}</span>
                      <span className="text-slate-500">Pack: {p.pack_no}</span>
                      <span className="text-blue-700 font-bold">{p.content_qty} PCS</span>
                      <span className="text-slate-400">{p.gross_weight_kg} KG</span>
                    </label>
                  ))}
                </div>
              </div>

              <Textarea label="Remarks" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} rows={2} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button onClick={handleCreatePlan} loading={saving}>Create Plan</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   4. SHIPMENTS LIST & DETAIL
============================================================ */
export function ShipmentListPage() {
  const [shipments, setShipments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/shipments').then(r => setShipments(r.data.data || [])).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Shipments</h1>
          <p className="text-sm text-slate-500">Domestic & export shipment lifecycle management</p>
        </div>
        <Button onClick={() => nav('/logistics/shipments/new')}>+ New Shipment</Button>
      </div>

      <Card>
        <DataTable
          data={shipments}
          loading={loading}
          columns={[
            { key: 'shipment_no', header: 'Shipment No', sortable: true,
              render: (r: any) => (
                <button onClick={() => nav(`/logistics/shipments/${r.id}`)}
                  className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                  {r.shipment_no}
                </button>
              ) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => r.io_no ? <Badge variant="outline" color="indigo">{r.io_no}</Badge> : '—' },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'shipment_type', header: 'Type', render: (r: any) => <Badge color={r.shipment_type === 'EXPORT' ? 'blue' : 'slate'}>{r.shipment_type}</Badge> },
            { key: 'mode', header: 'Mode', render: (r: any) => <Badge variant="outline">{r.mode}</Badge> },
            { key: 'destination', header: 'Destination' },
            { key: 'total_packages', header: 'Packages', align: 'right' as const, render: (r: any) => fmtNumber(r.total_packages) },
            { key: 'total_qty', header: 'Total Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'tracking_status', header: 'Status', render: (r: any) => <Badge color="blue">{r.tracking_status || 'BOOKED'}</Badge> },
          ]}
        />
      </Card>
    </div>
  );
}

export function ShipmentDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    shipment_no: '', io_no: '', so_id: null, packing_list_id: null,
    buyer_id: null, consignee_id: null, notify_party_id: null,
    shipment_type: 'DOMESTIC', mode: 'ROAD', incoterm: '',
    destination: '', country_id: null, freight_terms: '', remarks: '',
    shipping_line: '', vessel_name: '', voyage_no: '', bl_no: '', bl_date: '',
    etd: '', eta: '', pol: '', pod: '',
  });

  const [packages, setPackages] = useState<any[]>([]);
  const [itemSummary, setItemSummary] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [containers, setContainers] = useState<any[]>([]);
  const [availablePackages, setAvailablePackages] = useState<any[]>([]);
  const [selectedPkgs, setSelectedPkgs] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  // Lookups
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [packingLists, setPackingLists] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const toast = useToast();

  // Modals
  const [showContainerModal, setShowContainerModal] = useState(false);
  const [containerForm, setContainerForm] = useState<any>({
    container_no: 'MSCU1234567', container_type: '40HC', seal_no: 'SEAL001',
    tare_weight_kg: 3800, net_weight_kg: 12000, gross_weight_kg: 15800,
    max_cbm: 68, loaded_cbm: 62, stuffing_date: today(), stuffing_location: 'FACTORY', status: 'PLANNED', remarks: '',
  });

  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingForm, setTrackingForm] = useState<any>({
    event_type: 'LOADED', event_location: '', remarks: '',
  });

  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [deliveryForm, setDeliveryForm] = useState<any>({
    delivered_date: today(), receiver_name: '', pod_ref: '', remarks: '',
  });

  const [showLabelsModal, setShowLabelsModal] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/packing-lists'),
      api.get('/lookups/parties'),
    ]).then(([so, pl, pt]) => {
      setSalesOrders(so.data.data || []);
      setPackingLists(pl.data.data || []);
      setBuyers(pt.data.data || []);
    });

    if (isNew) {
      api.get('/available-packages').then(r => setAvailablePackages(r.data.data || []));
    }
  }, [isNew]);

  const fetchShipmentDetail = () => {
    if (!isNew) {
      api.get(`/shipments/${id}`).then(r => {
        const d = r.data.data;
        setHeader(d);
        setPackages(d.packages || []);
        setItemSummary(d.itemSummary || []);
        setDocuments(d.documents || []);
      });
      api.get(`/shipments/${id}/containers`).then(r => setContainers(r.data.data || []));
    }
  };

  useEffect(() => {
    fetchShipmentDetail();
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const handlePlSelect = (plIdVal: string) => {
    const plId = plIdVal ? Number(plIdVal) : null;
    const pl = packingLists.find(p => p.id === plId);
    setHeader((prev: any) => ({
      ...prev,
      packing_list_id: plId,
      io_no: pl?.io_no || prev.io_no,
      so_id: pl?.so_id || prev.so_id,
      buyer_id: pl?.buyer_id || prev.buyer_id,
      consignee_id: pl?.consignee_id || prev.consignee_id,
      destination: pl?.destination || prev.destination,
      shipment_type: pl?.shipment_type || prev.shipment_type,
    }));
    if (pl?.packing_id) {
      api.get(`/available-packages?packing_id=${pl.packing_id}`).then(r => setAvailablePackages(r.data.data || []));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...header, package_ids: selectedPkgs };
      if (isNew) {
        const r = await api.post('/shipments', payload);
        toast('Shipment created');
        nav(`/logistics/shipments/${r.data.data.id}`);
      }
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Actions
  const handleReadyToDispatch = async () => {
    try {
      await api.post(`/shipments/${id}/ready-to-dispatch`);
      toast('Shipment validated and marked Ready to Dispatch!');
      fetchShipmentDetail();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Action failed', 'error');
    }
  };

  const handleAddContainer = async () => {
    try {
      await api.post(`/shipments/${id}/containers`, containerForm);
      toast('Container assigned to shipment');
      setShowContainerModal(false);
      fetchShipmentDetail();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to add container', 'error');
    }
  };

  const handleAddTracking = async () => {
    try {
      await api.post(`/shipments/${id}/tracking`, trackingForm);
      toast('Tracking milestone recorded');
      setShowTrackingModal(false);
      fetchShipmentDetail();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Failed to record tracking', 'error');
    }
  };

  const handleConfirmDelivery = async () => {
    try {
      await api.post(`/shipments/${id}/delivery`, deliveryForm);
      toast('Proof of Delivery confirmed! Shipment closed.');
      setShowDeliveryModal(false);
      fetchShipmentDetail();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Delivery confirmation failed', 'error');
    }
  };

  const handleCancelShipment = async () => {
    if (!window.confirm('Are you sure you want to cancel this shipment? Allocated packages will be released.')) return;
    try {
      await api.post(`/shipments/${id}/cancel`);
      toast('Shipment cancelled and packages released');
      fetchShipmentDetail();
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Cancel failed', 'error');
    }
  };

  const isExport = header.shipment_type === 'EXPORT';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Shipment' : `Shipment — ${header.shipment_no}`}
          </h1>
          <p className="text-sm text-slate-500">
            {isExport ? 'Export shipment with container allocation & customs documents' : 'Domestic road transport with LR & e-way bill'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/shipments')}>← Back</Button>
          {!isNew && (
            <>
              <Button variant="outline" onClick={() => setShowLabelsModal(true)}>🏷️ Carton Labels</Button>
              <Button variant="outline" onClick={() => setShowTrackingModal(true)}>📍 Add Tracking</Button>
              <Button variant="outline" onClick={handleReadyToDispatch}>✓ Ready to Dispatch</Button>
              <Button variant="secondary" onClick={() => setShowDeliveryModal(true)}>📦 Confirm POD</Button>
              <Button variant="danger" onClick={handleCancelShipment}>Cancel</Button>
            </>
          )}
          {isNew && <Button onClick={handleSave} loading={saving}>Create Shipment</Button>}
        </div>
      </div>

      {/* Header Form */}
      <Card title="Shipment Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Input label="Shipment No" value={header.shipment_no || ''} disabled={!isNew}
            onChange={e => setField('shipment_no', e.target.value)} placeholder="Auto-generate" />
          
          <div>
            <Input label="I/O No" value={header.io_no || ''} onChange={e => setField('io_no', e.target.value)}
              disabled={Boolean(header.packing_list_id)} />
            {header.packing_list_id && <span className="text-[10px] text-indigo-600 font-medium">🔒 Inherited from Packing List</span>}
          </div>

          <Select label="Packing List Source" value={header.packing_list_id || ''}
            onChange={e => handlePlSelect(e.target.value)}
            options={[{ value: '', label: '— Select Packing List —' }, ...packingLists.map((p: any) => ({ value: p.id, label: `${p.pl_no} (I/O: ${p.io_no || 'N/A'})` }))]} />

          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => setField('so_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Buyer" value={header.buyer_id || ''}
            onChange={e => setField('buyer_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Shipment Type" value={header.shipment_type}
            onChange={e => setField('shipment_type', e.target.value)}
            options={[{ value: 'DOMESTIC', label: 'Domestic' }, { value: 'EXPORT', label: 'Export' }]} />

          <Select label="Mode" value={header.mode}
            onChange={e => setField('mode', e.target.value)}
            options={['ROAD','AIR','SEA','COURIER'].map(m => ({ value: m, label: m }))} />
          <Input label="Destination" value={header.destination || ''} onChange={e => setField('destination', e.target.value)} />

          {isExport && (
            <>
              <Select label="Incoterm" value={header.incoterm || ''}
                onChange={e => setField('incoterm', e.target.value)}
                options={[{ value: '', label: '—' }, ...['FOB','CIF','CFR','EXW','DDP','DAP','FCA'].map(i => ({ value: i, label: i }))]} />
              <Input label="Freight Terms" value={header.freight_terms || ''} onChange={e => setField('freight_terms', e.target.value)} />
            </>
          )}
        </div>
      </Card>

      {/* Export Details */}
      {isExport && (
        <Card title="Export Shipping & Port Details">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
            <Input label="Shipping Line" value={header.shipping_line || ''} onChange={e => setField('shipping_line', e.target.value)} />
            <Input label="Vessel Name" value={header.vessel_name || ''} onChange={e => setField('vessel_name', e.target.value)} />
            <Input label="Voyage No" value={header.voyage_no || ''} onChange={e => setField('voyage_no', e.target.value)} />
            <Input label="BL / AWB No" value={header.bl_no || ''} onChange={e => setField('bl_no', e.target.value)} />
            <Input label="BL Date" type="date" value={header.bl_date || ''} onChange={e => setField('bl_date', e.target.value)} />
            <Input label="Port of Loading (POL)" value={header.pol || ''} onChange={e => setField('pol', e.target.value)} />
            <Input label="Port of Discharge (POD)" value={header.pod || ''} onChange={e => setField('pod', e.target.value)} />
            <Input label="ETD" type="date" value={header.etd || ''} onChange={e => setField('etd', e.target.value)} />
            <Input label="ETA" type="date" value={header.eta || ''} onChange={e => setField('eta', e.target.value)} />
          </div>
        </Card>
      )}

      {/* Export Containers Card */}
      {isExport && !isNew && (
        <Card
          title={`Containers (${containers.length})`}
          actions={<Button size="sm" onClick={() => setShowContainerModal(true)}>+ Add Container</Button>}
        >
          <div className="p-4">
            {containers.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-500">
                    <th className="pb-2">Container No</th>
                    <th className="pb-2">Type</th>
                    <th className="pb-2">Seal No</th>
                    <th className="pb-2 text-right">Tare Wt</th>
                    <th className="pb-2 text-right">Gross Wt</th>
                    <th className="pb-2 text-right">CBM</th>
                    <th className="pb-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {containers.map(c => (
                    <tr key={c.id} className="border-b border-slate-50">
                      <td className="py-2 font-mono font-bold">{c.container_no}</td>
                      <td className="py-2">{c.container_type}</td>
                      <td className="py-2 font-mono text-xs">{c.seal_no || '—'}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.tare_weight_kg)}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.gross_weight_kg)}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.loaded_cbm, 3)}</td>
                      <td className="py-2"><Badge color="blue">{c.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-slate-400 italic">No containers assigned yet</p>}
          </div>
        </Card>
      )}

      {/* Package Selection (New Shipment) */}
      {isNew && (
        <Card title={`Select Packages to Allocate (${selectedPkgs.length} selected)`}>
          <div className="p-4 max-h-72 overflow-y-auto">
            {availablePackages.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-500">
                    <th className="pb-2 w-8"></th>
                    <th className="pb-2">Carton No</th>
                    <th className="pb-2">Packing Ref</th>
                    <th className="pb-2">SKU Summary</th>
                    <th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Gross Wt</th>
                    <th className="pb-2 text-right">CBM</th>
                  </tr>
                </thead>
                <tbody>
                  {availablePackages.map(p => (
                    <tr key={p.id} className="border-b border-slate-50">
                      <td className="py-1.5">
                        <input
                          type="checkbox"
                          checked={selectedPkgs.includes(p.id)}
                          onChange={e => setSelectedPkgs(prev => e.target.checked ? [...prev, p.id] : prev.filter(i => i !== p.id))}
                        />
                      </td>
                      <td className="py-1.5 font-mono text-xs font-semibold">{p.carton_no}</td>
                      <td className="py-1.5">{p.pack_no}</td>
                      <td className="py-1.5 text-xs text-slate-500">{p.sku_summary}</td>
                      <td className="py-1.5 text-right font-bold">{fmtNumber(p.content_qty)}</td>
                      <td className="py-1.5 text-right">{fmtDecimal(p.gross_weight_kg)}</td>
                      <td className="py-1.5 text-right">{fmtDecimal(p.cbm, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-slate-400 italic">No available packages found</p>}
          </div>
        </Card>
      )}

      {/* Allocated Packages (Existing) */}
      {!isNew && (
        <Card title={`Allocated Cartons (${packages.length})`}>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Carton No</th>
                  <th className="pb-2 text-right">Allocated Qty</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {packages.map(p => (
                  <tr key={p.id} className="border-b border-slate-50">
                    <td className="py-1.5 font-mono text-xs font-semibold">{p.carton_no}</td>
                    <td className="py-1.5 text-right font-bold text-blue-700">{fmtNumber(p.allocated_qty)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_gross)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_cbm, 3)}</td>
                    <td className="py-1.5"><Badge color={p.status === 'DELIVERED' ? 'emerald' : p.status === 'DISPATCHED' ? 'amber' : 'blue'}>{p.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Item Summary Breakdown */}
      {itemSummary.length > 0 && (
        <Card title="Shipped Item Breakdown (Style / Color / Size)">
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Style</th>
                  <th className="pb-2">Color</th>
                  <th className="pb-2">Size</th>
                  <th className="pb-2 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {itemSummary.map((item: any, idx: number) => (
                  <tr key={idx} className="border-b border-slate-50">
                    <td className="py-1.5 font-medium">{item.style_code || '-'}</td>
                    <td className="py-1.5">{item.color_name || '-'}</td>
                    <td className="py-1.5">{item.size_code || '-'}</td>
                    <td className="py-1.5 text-right font-bold text-blue-700">{fmtNumber(item.total_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Shipment Documents */}
      {documents.length > 0 && (
        <Card title="Shipping Documents">
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Document Type</th>
                  <th className="pb-2">Document No</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc: any) => (
                  <tr key={doc.id} className="border-b border-slate-50">
                    <td className="py-1.5 font-medium">{doc.doc_name}</td>
                    <td className="py-1.5">{doc.document_no || '-'}</td>
                    <td className="py-1.5"><Badge color={doc.status === 'COMPLETED' ? 'emerald' : 'amber'}>{doc.status || 'PENDING'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Add Container Modal */}
      {showContainerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Assign Container to Shipment</h3>
              <button onClick={() => setShowContainerModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Container No *" value={containerForm.container_no}
                  onChange={e => setContainerForm({ ...containerForm, container_no: e.target.value })} />
                <Select label="Type" value={containerForm.container_type}
                  onChange={e => setContainerForm({ ...containerForm, container_type: e.target.value })}
                  options={['20FT','40FT','40HC','45HC','LCL'].map(t => ({ value: t, label: t }))} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input label="Seal No" value={containerForm.seal_no}
                  onChange={e => setContainerForm({ ...containerForm, seal_no: e.target.value })} />
                <Input label="Stuffing Location" value={containerForm.stuffing_location}
                  onChange={e => setContainerForm({ ...containerForm, stuffing_location: e.target.value })} />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <Input label="Tare Weight (KG)" type="number" value={containerForm.tare_weight_kg}
                  onChange={e => setContainerForm({ ...containerForm, tare_weight_kg: Number(e.target.value) })} />
                <Input label="Gross Weight (KG)" type="number" value={containerForm.gross_weight_kg}
                  onChange={e => setContainerForm({ ...containerForm, gross_weight_kg: Number(e.target.value) })} />
                <Input label="Loaded CBM" type="number" value={containerForm.loaded_cbm}
                  onChange={e => setContainerForm({ ...containerForm, loaded_cbm: Number(e.target.value) })} />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowContainerModal(false)}>Cancel</Button>
              <Button onClick={handleAddContainer}>Add Container</Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Tracking Modal */}
      {showTrackingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Add Tracking Milestone</h3>
              <button onClick={() => setShowTrackingModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <Select label="Milestone Event *" value={trackingForm.event_type}
                onChange={e => setTrackingForm({ ...trackingForm, event_type: e.target.value })}
                options={[
                  { value: 'GATED_IN', label: 'Gated In (Port/CFS)' },
                  { value: 'LOADED', label: 'Loaded on Vessel/Vehicle' },
                  { value: 'SAILED', label: 'Vessel Sailed / Vehicle Departed' },
                  { value: 'TRANSIT', label: 'In Transit' },
                  { value: 'CUSTOMS_CLEARANCE', label: 'Customs Cleared' },
                  { value: 'ARRIVED', label: 'Arrived at Destination Port' },
                  { value: 'DELIVERED', label: 'Delivered to Consignee' },
                ]}
              />
              <Input label="Current Location" value={trackingForm.event_location}
                onChange={e => setTrackingForm({ ...trackingForm, event_location: e.target.value })} placeholder="e.g. Chennai Port" />
              <Input label="Remarks" value={trackingForm.remarks}
                onChange={e => setTrackingForm({ ...trackingForm, remarks: e.target.value })} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowTrackingModal(false)}>Cancel</Button>
              <Button onClick={handleAddTracking}>Post Milestone</Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delivery POD Modal */}
      {showDeliveryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Confirm Delivery & POD</h3>
              <button onClick={() => setShowDeliveryModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4">
              <Input label="Delivered Date *" type="date" value={deliveryForm.delivered_date}
                onChange={e => setDeliveryForm({ ...deliveryForm, delivered_date: e.target.value })} />
              <Input label="Receiver Name *" value={deliveryForm.receiver_name}
                onChange={e => setDeliveryForm({ ...deliveryForm, receiver_name: e.target.value })} placeholder="e.g. John Doe (Store Manager)" />
              <Input label="POD Docket / Ack Ref" value={deliveryForm.pod_ref}
                onChange={e => setDeliveryForm({ ...deliveryForm, pod_ref: e.target.value })} placeholder="POD-99823" />
              <Textarea label="Remarks" value={deliveryForm.remarks}
                onChange={e => setDeliveryForm({ ...deliveryForm, remarks: e.target.value })} rows={2} />
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowDeliveryModal(false)}>Cancel</Button>
              <Button onClick={handleConfirmDelivery}>Close Shipment (Delivered)</Button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Carton Labels Modal */}
      {showLabelsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-6 py-4 bg-slate-50">
              <h3 className="text-lg font-bold text-slate-800">Carton Barcode Shipping Labels</h3>
              <button onClick={() => setShowLabelsModal(false)} className="text-slate-400 font-bold">✕</button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                {packages.map((pkg, idx) => (
                  <div key={idx} className="border-2 border-dashed border-slate-300 rounded-lg p-4 bg-white space-y-2">
                    <div className="flex justify-between border-b pb-1">
                      <span className="text-xs font-bold text-slate-800">TEXTILE EXPORTS</span>
                      <span className="font-mono text-xs font-bold text-indigo-700">{pkg.carton_no}</span>
                    </div>
                    <div className="text-[11px] space-y-0.5">
                      <p><strong>I/O:</strong> {header.io_no || 'N/A'}</p>
                      <p><strong>Shipment:</strong> {header.shipment_no}</p>
                      <p><strong>Qty:</strong> {pkg.allocated_qty} PCS</p>
                      <p><strong>Gross Wt:</strong> {pkg.carton_gross || pkg.gross_weight_kg} KG</p>
                    </div>
                    <div className="pt-2 text-center border-t">
                      <div className="font-mono text-lg font-black tracking-widest bg-slate-100 py-1 rounded">
                        ||| | |||| | |||||
                      </div>
                      <span className="font-mono text-[10px] text-slate-500">{pkg.carton_no}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t px-6 py-4 bg-slate-50">
              <Button variant="ghost" onClick={() => setShowLabelsModal(false)}>Close</Button>
              <Button onClick={() => window.print()}>🖨️ Print Labels</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   5. DISPATCH LIST & DETAIL
============================================================ */
export function DispatchListPage() {
  const [dispatches, setDispatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/dispatches').then(r => setDispatches(r.data.data)).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Dispatches</h1>
          <p className="text-sm text-slate-500">Vehicle, LR, E-Way Bill and dispatch tracking</p>
        </div>
        <Button onClick={() => nav('/logistics/dispatches/new')}>+ New Dispatch</Button>
      </div>

      <Card>
        <DataTable
          data={dispatches}
          loading={loading}
          columns={[
            { key: 'dispatch_no', header: 'Dispatch No', sortable: true,
              render: (r: any) => (
                <button onClick={() => nav(`/logistics/dispatches/${r.id}`)}
                  className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                  {r.dispatch_no}
                </button>
              ) },
            { key: 'dispatch_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.dispatch_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => r.io_no ? <Badge variant="outline" color="indigo">{r.io_no}</Badge> : '—' },
            { key: 'shipment_no', header: 'Shipment' },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'vehicle_no', header: 'Vehicle', render: (r: any) => r.vehicle_no ? <Badge variant="outline">{r.vehicle_no}</Badge> : '—' },
            { key: 'lr_no', header: 'LR No' },
            { key: 'eway_bill_no', header: 'E-Way Bill' },
            { key: 'total_cartons', header: 'Cartons', align: 'right' as const, render: (r: any) => fmtNumber(r.total_cartons) },
            { key: 'status_label', header: 'Status', render: (r: any) => r.status_label ? <Badge>{r.status_label}</Badge> : '—' },
          ]}
        />
      </Card>
    </div>
  );
}

export function DispatchDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    dispatch_no: '', dispatch_date: today(), io_no: '', so_id: null,
    shipment_id: null, packing_id: null, buyer_id: null,
    transporter_id: null, vehicle_no: '', driver_name: '',
    lr_no: '', lr_date: '', eway_bill_no: '', dispatch_time: '',
    delivery_location: '', mode: 'ROAD',
    total_cartons: 0, total_qty: 0, gross_weight_kg: '', total_cbm: '',
    status_id: null, remarks: '',
  });
  const [saving, setSaving] = useState(false);

  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const [shipments, setShipments] = useState<any[]>([]);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/lookups/parties'),
      api.get('/shipments'),
    ]).then(([so, pt, sh]) => {
      setSalesOrders(so.data.data || []);
      setBuyers(pt.data.data || []);
      setShipments(sh.data.data || []);
    });
  }, []);

  useEffect(() => {
    if (!isNew) {
      api.get(`/dispatches/${id}`).then(r => setHeader(r.data.data));
    }
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const handleShipmentSelect = (shipIdVal: string) => {
    const shipId = shipIdVal ? Number(shipIdVal) : null;
    const sh = shipments.find(s => s.id === shipId);
    setHeader((prev: any) => ({
      ...prev,
      shipment_id: shipId,
      io_no: sh?.io_no || prev.io_no,
      so_id: sh?.so_id || prev.so_id,
      buyer_id: sh?.buyer_id || prev.buyer_id,
      delivery_location: sh?.destination || prev.delivery_location,
      total_cartons: sh?.total_packages || prev.total_cartons,
      total_qty: sh?.total_qty || prev.total_qty,
      gross_weight_kg: sh?.gross_weight_kg || prev.gross_weight_kg,
      total_cbm: sh?.total_cbm || prev.total_cbm,
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const r = await api.post('/dispatches', header);
        toast('Dispatch created');
        nav(`/logistics/dispatches/${r.data.data.id}`);
      }
    } catch (e: any) {
      toast(e?.response?.data?.error?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Dispatch' : `Dispatch — ${header.dispatch_no}`}
          </h1>
          <p className="text-sm text-slate-500">Transport, LR & E-Way Bill details</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/dispatches')}>← Back</Button>
          {isNew && <Button onClick={handleSave} loading={saving}>Create Dispatch</Button>}
        </div>
      </div>

      <Card title="Dispatch Header">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Input label="Dispatch No" value={header.dispatch_no} disabled={!isNew}
            onChange={e => setField('dispatch_no', e.target.value)} placeholder="Auto-generate" />
          <Input label="Dispatch Date" type="date" value={header.dispatch_date?.slice?.(0, 10) || header.dispatch_date}
            onChange={e => setField('dispatch_date', e.target.value)} />
          <div>
            <Input label="I/O No" value={header.io_no || ''} onChange={e => setField('io_no', e.target.value)}
              disabled={Boolean(header.shipment_id)} />
            {header.shipment_id && <span className="text-[10px] text-indigo-600 font-medium">🔒 Inherited from Shipment</span>}
          </div>

          <Select label="Shipment Reference *" value={header.shipment_id || ''}
            onChange={e => handleShipmentSelect(e.target.value)}
            options={[{ value: '', label: '— Select Shipment —' }, ...shipments.map((s: any) => ({ value: s.id, label: `${s.shipment_no} (I/O: ${s.io_no || 'N/A'})` }))]} />
          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => setField('so_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Buyer" value={header.buyer_id || ''}
            onChange={e => setField('buyer_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
        </div>
      </Card>

      <Card title="Transport Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Select label="Transporter" value={header.transporter_id || ''}
            onChange={e => setField('transporter_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Input label="Vehicle No" value={header.vehicle_no || ''} onChange={e => setField('vehicle_no', e.target.value)}
            placeholder="TN 39 AB 1234" />
          <Input label="Driver Name" value={header.driver_name || ''} onChange={e => setField('driver_name', e.target.value)} />
          <Input label="LR No" value={header.lr_no || ''} onChange={e => setField('lr_no', e.target.value)} />
          <Input label="LR Date" type="date" value={header.lr_date || ''} onChange={e => setField('lr_date', e.target.value)} />
          <Input label="E-Way Bill No" value={header.eway_bill_no || ''} onChange={e => setField('eway_bill_no', e.target.value)} />
          <Input label="Dispatch Time" type="time" value={header.dispatch_time || ''} onChange={e => setField('dispatch_time', e.target.value)} />
          <Input label="Delivery Location" value={header.delivery_location || ''} onChange={e => setField('delivery_location', e.target.value)} />
          <Select label="Mode" value={header.mode}
            onChange={e => setField('mode', e.target.value)}
            options={['ROAD','AIR','SEA','COURIER'].map(m => ({ value: m, label: m }))} />
        </div>
      </Card>

      <Card title="Quantity Summary">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
          <Input label="Total Cartons" type="number" value={header.total_cartons}
            onChange={e => setField('total_cartons', Number(e.target.value))} />
          <Input label="Total Qty" type="number" value={header.total_qty}
            onChange={e => setField('total_qty', Number(e.target.value))} />
          <Input label="Gross Weight (KG)" type="number" value={header.gross_weight_kg || ''}
            onChange={e => setField('gross_weight_kg', e.target.value)} />
          <Input label="Total CBM" type="number" value={header.total_cbm || ''}
            onChange={e => setField('total_cbm', e.target.value)} />
        </div>
      </Card>

      <Card title="Remarks">
        <div className="p-4">
          <Textarea value={header.remarks || ''} rows={3}
            onChange={e => setField('remarks', e.target.value)} />
        </div>
      </Card>
    </div>
  );
}

export default PackingListPage;
