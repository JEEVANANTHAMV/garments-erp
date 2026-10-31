import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, DataTable, Textarea, Modal, FormSection } from '../../components/ui';
import { Ship, Container, MapPin, PackageCheck, Tag } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { JobSelect } from '../../components/JobSelect';
import { EwayBillButton, useEwayBill } from '../../components/EwayBillButton';

/* ============================================================
   1-2. PACKING LISTS — register + ASSORTED / SOLID / MIXED editor
   (moved to PackingListEditor.tsx; re-exported so routes are unchanged)
============================================================ */
import { PackingListPage, PackingListDetailPage } from './PackingListEditor';
export { PackingListPage, PackingListDetailPage };

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
  const [readyLists, setReadyLists] = useState<any[]>([]);      // CONFIRMED packing lists not yet shipped
  const toast = useToast();
  const nav = useNavigate();

  const [form, setForm] = useState<any>({
    packing_list_id: '',
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
      api.get('/lookups/buyers'),
      api.get('/packing-lists', { params: { for_shipment: 1 } }),
    ]).then(([pk, pt, pl]) => {
      setAvailablePkgs(pk.data.data || []);
      setBuyers(pt.data.data || []);
      setReadyLists(pl.data.data || []);
    });
  }, []);

  const planPl = readyLists.find((p) => String(p.id) === String(form.packing_list_id));
  /** Picking a confirmed packing list takes its cartons (all pre-selected) or, for a hand-made list, its row totals. */
  const pickPlanList = async (v: string) => {
    const pl = readyLists.find((p) => String(p.id) === v);
    setForm((f: any) => ({ ...f, packing_list_id: v, ...(pl ? { buyer_id: pl.buyer_id ?? f.buyer_id, shipment_type: pl.shipment_type || f.shipment_type, destination: pl.destination || f.destination } : {}) }));
    const r = await api.get('/available-packages', { params: v ? { packing_list_id: v } : {} });
    setAvailablePkgs(r.data.data || []);
    setSelectedPkgs(v ? (r.data.data || []).map((c: any) => c.id) : []);
  };

  const handleCreatePlan = async () => {
    setSaving(true);
    try {
      await api.post('/shipment-plans', {
        ...form,
        buyer_id: form.buyer_id ? Number(form.buyer_id) : null,
        packing_list_id: form.packing_list_id ? Number(form.packing_list_id) : null,
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
          <h1 className="text-2xl font-bold text-ink">Shipment Planning</h1>
          <p className="text-sm text-ink-secondary">Plan and reserve confirmed packages for domestic and export shipping</p>
        </div>
        <Button onClick={() => setShowModal(true)}>+ New Shipment Plan</Button>
      </div>

      <Card>
        <DataTable
          data={plans}
          loading={loading}
          columns={[
            { key: 'plan_no', header: 'Plan No', sortable: true, render: (r: any) => <span className="tabular-nums text-xs font-bold text-brand-700">{r.plan_no}</span> },
            { key: 'planned_date', header: 'Planned Date', sortable: true, render: (r: any) => fmtDate(r.planned_date) },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'packing_list_no', header: 'Packing list', render: (r: any) => r.packing_list_no
              ? <span className="text-xs">{r.packing_list_no}{r.package_basis === 'PACKING_LIST' && <Badge color="amber" className="ml-1">list totals</Badge>}</span> : '—' },
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
      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Shipment Plan" size="lg"
        subtitle="Plan a shipment from confirmed packages, then convert it to a shipment"
        icon={<Ship size={16} />}
        footerStart={planPl && !selectedPkgs.length
          ? <>List totals: <b>{fmtNumber(planPl.total_cartons)}</b> ctns · <b>{fmtNumber(planPl.total_qty)}</b> pcs</>
          : <><b>{selectedPkgs.length}</b> package(s) selected · <b>{fmtNumber(availablePkgs.filter((p) => selectedPkgs.includes(p.id)).reduce((a, p) => a + Number(p.content_qty || 0), 0))}</b> pcs</>}
        footer={<>
          <Button variant="secondary" onClick={() => setShowModal(false)}>Cancel</Button>
          <Button onClick={handleCreatePlan} loading={saving}>Create Plan</Button>
        </>}>
        <FormSection title="Plan" cols={3}>
          <Select label="From packing list (confirmed)" value={form.packing_list_id} id="plan-pl" className="lg:col-span-3"
            onChange={e => void pickPlanList(e.target.value)}
            options={[{ value: '', label: '— None: pick cartons below —' }, ...readyLists.map((p: any) => ({ value: p.id,
              label: `${p.pl_no} · ${p.io_no || p.so_no || '—'} · ${fmtNumber(p.total_cartons)} ctns / ${fmtNumber(p.total_qty)} pcs${Number(p.linked_cartons) ? '' : ' (list totals)'}` }))]} />
          <Input label="Planned Date" type="date" value={form.planned_date}
            onChange={e => setForm({ ...form, planned_date: e.target.value })} />
          <Select label="Buyer" value={form.buyer_id}
            onChange={e => setForm({ ...form, buyer_id: e.target.value })}
            options={[{ value: '', label: '— Select —' }, ...buyers.map(b => ({ value: b.id, label: b.label || b.code }))]} />
          <Select label="Shipment Type" value={form.shipment_type}
            onChange={e => setForm({ ...form, shipment_type: e.target.value })}
            options={[{ value: 'DOMESTIC', label: 'Domestic' }, { value: 'EXPORT', label: 'Export' }]} />
          <Select label="Mode" value={form.mode}
            onChange={e => setForm({ ...form, mode: e.target.value })}
            options={['ROAD','AIR','SEA','COURIER'].map(m => ({ value: m, label: m }))} />
          <Input label="Destination" value={form.destination} className="lg:col-span-2"
            onChange={e => setForm({ ...form, destination: e.target.value })} />
        </FormSection>

        <FormSection title={`Ready cartons — posted, verified / sealed (${selectedPkgs.length} selected)`} cols={1}>
          {planPl && !Number(planPl.linked_cartons) && (
            <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              {planPl.pl_no} is a hand-made list (not built from packed cartons): the plan takes its row totals — {fmtNumber(planPl.total_cartons)} cartons, {fmtNumber(planPl.total_qty)} pcs, {fmtDecimal(planPl.gross_weight_kg)} kg.
            </p>
          )}
          <div className="border rounded-lg max-h-48 overflow-y-auto p-2 divide-y">
            {availablePkgs.map(p => (
              <label key={p.id} className="flex items-center gap-3 p-2 hover:bg-surface-muted cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={selectedPkgs.includes(p.id)}
                  onChange={e => setSelectedPkgs(prev => e.target.checked ? [...prev, p.id] : prev.filter(i => i !== p.id))}
                />
                <span className="tabular-nums font-semibold">{p.carton_no}</span>
                <span className="text-ink-secondary">Pack: {p.pack_no}</span>
                <span className="text-blue-700 font-bold">{p.content_qty} PCS</span>
                <span className="text-ink-muted">{p.gross_weight_kg} KG</span>
                {p.pl_no && <span className="text-ink-muted">PL {p.pl_no}</span>}
                {Number(p.is_partial) === 1 && <Badge color="amber">partial</Badge>}
              </label>
            ))}
            {!availablePkgs.length && <p className="p-2 text-xs italic text-ink-muted">No ready cartons</p>}
          </div>
        </FormSection>

        <FormSection title="Remarks" cols={1}>
          <Textarea label="Remarks" value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} rows={2} />
        </FormSection>
      </Modal>
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
          <h1 className="text-2xl font-bold text-ink">Shipments</h1>
          <p className="text-sm text-ink-secondary">Domestic & export shipment lifecycle management</p>
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
                  className="tabular-nums text-xs font-semibold text-brand-700 hover:underline">
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
      api.get('/packing-lists', { params: isNew ? { for_shipment: 1 } : {} }),
      api.get('/lookups/buyers'),
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
    // a confirmed list brings its packed cartons (all selected); a hand-made list ships its row totals
    api.get('/available-packages', { params: plId ? { packing_list_id: plId } : {} }).then(r => {
      const rows = r.data.data || [];
      setAvailablePackages(rows);
      setSelectedPkgs(plId ? rows.map((c: any) => c.id) : []);
    });
  };
  const pickedPl = packingLists.find(p => p.id === header.packing_list_id);
  const listBased = Boolean(pickedPl && !Number(pickedPl.linked_cartons));

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
          <h1 className="text-2xl font-bold text-ink">
            {isNew ? 'New Shipment' : `Shipment — ${header.shipment_no}`}
          </h1>
          <p className="text-sm text-ink-secondary">
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
            <JobSelect label="I/O No" value={header.io_no || ''} disabled={Boolean(header.packing_list_id)} id="shp-io"
              onPick={(j) => setHeader((p: any) => ({ ...p, io_no: j?.job_no ?? '', so_id: j ? j.id : p.so_id, ...(j?.buyer_id && !p.buyer_id ? { buyer_id: j.buyer_id } : {}) }))} />
            {header.packing_list_id && <span className="text-micro text-indigo-600 font-medium">🔒 Inherited from Packing List</span>}
          </div>

          <div>
            <Select label="Packing List Source" value={header.packing_list_id || ''} id="shp-pl" disabled={!isNew}
              onChange={e => handlePlSelect(e.target.value)}
              options={[{ value: '', label: isNew ? '— Select confirmed packing list —' : '—' }, ...packingLists.map((p: any) => ({ value: p.id,
                label: `${p.pl_no} (I/O: ${p.io_no || 'N/A'}) · ${fmtNumber(p.total_cartons)} ctns / ${fmtNumber(p.total_qty)} pcs` }))]} />
            {!isNew && header.package_basis === 'PACKING_LIST' && <span className="text-micro font-medium text-amber-700">Totals from the packing list rows (hand-made list, no physical cartons)</span>}
          </div>

          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => {
              const so = salesOrders.find((x: any) => String(x.id) === e.target.value);
              setHeader((p: any) => ({ ...p, so_id: e.target.value ? Number(e.target.value) : null,
                ...(so && !p.shipment_id && !p.packing_list_id ? { io_no: so.job_no || so.io_no || so.so_no } : {}), ...(so?.buyer_id && !p.buyer_id ? { buyer_id: so.buyer_id } : {}) }));
            }}
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
                  <tr className="border-b text-left text-ink-secondary">
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
                    <tr key={c.id} className="border-b border-surface-divider">
                      <td className="py-2 tabular-nums font-bold">{c.container_no}</td>
                      <td className="py-2">{c.container_type}</td>
                      <td className="py-2 tabular-nums text-xs">{c.seal_no || '—'}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.tare_weight_kg)}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.gross_weight_kg)}</td>
                      <td className="py-2 text-right">{fmtDecimal(c.loaded_cbm, 3)}</td>
                      <td className="py-2"><Badge color="blue">{c.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-ink-muted italic">No containers assigned yet</p>}
          </div>
        </Card>
      )}

      {/* Package Selection (New Shipment) */}
      {isNew && listBased && pickedPl && (
        <Card title="Ships the packing list totals">
          <div className="p-4 text-sm text-amber-800" data-testid="shp-list-based">
            {pickedPl.pl_no} is not built from packed cartons. The shipment takes its row totals:
            <b> {fmtNumber(pickedPl.total_cartons)}</b> cartons · <b>{fmtNumber(pickedPl.total_qty)}</b> pcs · <b>{fmtDecimal(pickedPl.gross_weight_kg)}</b> kg gross · <b>{fmtDecimal(pickedPl.total_cbm, 3)}</b> CBM.
          </div>
        </Card>
      )}

      {isNew && !listBased && (
        <Card title={`Select Packages to Allocate (${selectedPkgs.length} selected · ${fmtNumber(availablePackages.filter(p => selectedPkgs.includes(p.id)).reduce((a, p) => a + Number(p.content_qty || 0), 0))} pcs)`}>
          <div className="p-4 max-h-72 overflow-y-auto">
            {availablePackages.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-ink-secondary">
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
                    <tr key={p.id} className="border-b border-surface-divider">
                      <td className="py-1.5">
                        <input
                          type="checkbox"
                          checked={selectedPkgs.includes(p.id)}
                          onChange={e => setSelectedPkgs(prev => e.target.checked ? [...prev, p.id] : prev.filter(i => i !== p.id))}
                        />
                      </td>
                      <td className="py-1.5 tabular-nums text-xs font-semibold">{p.carton_no}</td>
                      <td className="py-1.5">{p.pack_no}</td>
                      <td className="py-1.5 text-xs text-ink-secondary">{p.sku_summary}</td>
                      <td className="py-1.5 text-right font-bold">{fmtNumber(p.content_qty)}</td>
                      <td className="py-1.5 text-right">{fmtDecimal(p.gross_weight_kg)}</td>
                      <td className="py-1.5 text-right">{fmtDecimal(p.cbm, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-ink-muted italic">No ready cartons (posted, verified / sealed) found</p>}
          </div>
        </Card>
      )}

      {/* Allocated Packages (Existing) */}
      {!isNew && (
        <Card title={header.package_basis === 'PACKING_LIST'
          ? `Packing list totals — ${fmtNumber(header.total_packages)} cartons · ${fmtNumber(header.total_qty)} pcs (no physical cartons)`
          : `Allocated Cartons (${packages.length})`}>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-ink-secondary">
                  <th className="pb-2">Carton No</th>
                  <th className="pb-2 text-right">Allocated Qty</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                  <th className="pb-2">Status</th>
                  <th className="pb-2">Carton</th>
                </tr>
              </thead>
              <tbody>
                {packages.map(p => (
                  <tr key={p.id} className="border-b border-surface-divider">
                    <td className="py-1.5 tabular-nums text-xs font-semibold">{p.carton_no}</td>
                    <td className="py-1.5 text-right font-bold text-blue-700">{fmtNumber(p.allocated_qty)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_gross)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_cbm, 3)}</td>
                    <td className="py-1.5"><Badge color={p.status === 'DELIVERED' ? 'emerald' : p.status === 'DISPATCHED' ? 'amber' : 'blue'}>{p.status}</Badge></td>
                    <td className="py-1.5 text-xs text-ink-secondary">{p.carton_status || '—'}</td>
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
                <tr className="border-b text-left text-ink-secondary">
                  <th className="pb-2">Style</th>
                  <th className="pb-2">Color</th>
                  <th className="pb-2">Size</th>
                  <th className="pb-2 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {itemSummary.map((item: any, idx: number) => (
                  <tr key={idx} className="border-b border-surface-divider">
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
                <tr className="border-b text-left text-ink-secondary">
                  <th className="pb-2">Document Type</th>
                  <th className="pb-2">Document No</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc: any) => (
                  <tr key={doc.id} className="border-b border-surface-divider">
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
      <Modal open={showContainerModal} onClose={() => setShowContainerModal(false)} size="md"
        title={`Assign container to shipment ${header.shipment_no ?? ''}`}
        icon={<Container size={16} />}
        footer={<>
          <Button variant="secondary" onClick={() => setShowContainerModal(false)}>Cancel</Button>
          <Button onClick={handleAddContainer}>Add Container</Button>
        </>}>
        <FormSection title="Container" cols={2}>
          <Input label="Container No *" value={containerForm.container_no}
            onChange={e => setContainerForm({ ...containerForm, container_no: e.target.value })} />
          <Select label="Type" value={containerForm.container_type}
            onChange={e => setContainerForm({ ...containerForm, container_type: e.target.value })}
            options={['20FT','40FT','40HC','45HC','LCL'].map(t => ({ value: t, label: t }))} />
          <Input label="Seal No" value={containerForm.seal_no}
            onChange={e => setContainerForm({ ...containerForm, seal_no: e.target.value })} />
          <Input label="Stuffing Location" value={containerForm.stuffing_location}
            onChange={e => setContainerForm({ ...containerForm, stuffing_location: e.target.value })} />
        </FormSection>
        <FormSection title="Weights & volume" cols={3}>
          <Input label="Tare Weight (KG)" type="number" value={containerForm.tare_weight_kg}
            onChange={e => setContainerForm({ ...containerForm, tare_weight_kg: Number(e.target.value) })} />
          <Input label="Gross Weight (KG)" type="number" value={containerForm.gross_weight_kg}
            onChange={e => setContainerForm({ ...containerForm, gross_weight_kg: Number(e.target.value) })} />
          <Input label="Loaded CBM" type="number" value={containerForm.loaded_cbm}
            onChange={e => setContainerForm({ ...containerForm, loaded_cbm: Number(e.target.value) })} />
        </FormSection>
      </Modal>

      {/* Add Tracking Modal */}
      <Modal open={showTrackingModal} onClose={() => setShowTrackingModal(false)} size="sm"
        title={`Add tracking milestone${header.shipment_no ? ` — ${header.shipment_no}` : ''}`}
        icon={<MapPin size={16} />}
        footer={<>
          <Button variant="secondary" onClick={() => setShowTrackingModal(false)}>Cancel</Button>
          <Button onClick={handleAddTracking}>Post Milestone</Button>
        </>}>
        <FormSection cols={1}>
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
        </FormSection>
      </Modal>

      {/* Confirm Delivery POD Modal */}
      <Modal open={showDeliveryModal} onClose={() => setShowDeliveryModal(false)} size="md"
        title={`Confirm delivery${header.shipment_no ? ` — ${header.shipment_no}` : ''}`}
        subtitle="Records the proof of delivery and closes the shipment as delivered"
        icon={<PackageCheck size={16} />}
        footer={<>
          <Button variant="secondary" onClick={() => setShowDeliveryModal(false)}>Cancel</Button>
          <Button onClick={handleConfirmDelivery}>Close Shipment (Delivered)</Button>
        </>}>
        <FormSection cols={3}>
          <Input label="Delivered Date *" type="date" value={deliveryForm.delivered_date}
            onChange={e => setDeliveryForm({ ...deliveryForm, delivered_date: e.target.value })} />
          <Input label="Receiver Name *" value={deliveryForm.receiver_name}
            onChange={e => setDeliveryForm({ ...deliveryForm, receiver_name: e.target.value })} placeholder="e.g. John Doe (Store Manager)" />
          <Input label="POD Docket / Ack Ref" value={deliveryForm.pod_ref}
            onChange={e => setDeliveryForm({ ...deliveryForm, pod_ref: e.target.value })} placeholder="POD-99823" />
          <Textarea label="Remarks" value={deliveryForm.remarks} className="sm:col-span-2 lg:col-span-3"
            onChange={e => setDeliveryForm({ ...deliveryForm, remarks: e.target.value })} rows={2} />
        </FormSection>
      </Modal>

      {/* Printable Carton Labels Modal */}
      <Modal open={showLabelsModal} onClose={() => setShowLabelsModal(false)} size="lg"
        title={`Carton labels${header.shipment_no ? ` — ${header.shipment_no}` : ''}`}
        subtitle="Barcode shipping labels for every carton on this shipment"
        icon={<Tag size={16} />}
        footerStart={<><b>{packages.length}</b> carton(s)</>}
        footer={<>
          <Button variant="secondary" onClick={() => setShowLabelsModal(false)}>Close</Button>
          <Button onClick={() => window.print()}>🖨️ Print Labels</Button>
        </>}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {packages.map((pkg, idx) => (
            <div key={idx} className="border-2 border-dashed border-surface-input rounded-lg p-4 bg-white space-y-2">
              <div className="flex justify-between border-b pb-1">
                <span className="text-xs font-bold text-ink">TEXTILE EXPORTS</span>
                <span className="tabular-nums text-xs font-bold text-indigo-700">{pkg.carton_no}</span>
              </div>
              <div className="text-caption space-y-0.5">
                <p><strong>I/O:</strong> {header.io_no || 'N/A'}</p>
                <p><strong>Shipment:</strong> {header.shipment_no}</p>
                <p><strong>Qty:</strong> {pkg.allocated_qty} PCS</p>
                <p><strong>Gross Wt:</strong> {pkg.carton_gross || pkg.gross_weight_kg} KG</p>
              </div>
              <div className="pt-2 text-center border-t">
                <div className="tabular-nums text-lg font-bold tracking-widest bg-surface-header py-1 rounded">
                  ||| | |||| | |||||
                </div>
                <span className="tabular-nums text-micro text-ink-secondary">{pkg.carton_no}</span>
              </div>
            </div>
          ))}
        </div>
      </Modal>
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
          <h1 className="text-2xl font-bold text-ink">Dispatches</h1>
          <p className="text-sm text-ink-secondary">Vehicle, LR, E-Way Bill and dispatch tracking</p>
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
                  className="tabular-nums text-xs font-semibold text-brand-700 hover:underline">
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
  const { data: ewb } = useEwayBill('DISPATCH', isNew ? null : id);   // generated EWB owns header.eway_bill_no

  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const [transporters, setTransporters] = useState<any[]>([]);
  const [shipments, setShipments] = useState<any[]>([]);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/lookups/receivables'),      // dispatch goes to a buyer or a (domestic) customer
      api.get('/shipments'),
      api.get('/lookups/transporters'),
    ]).then(([so, pt, sh, tr]) => {
      setSalesOrders(so.data.data || []);
      setBuyers(pt.data.data || []);
      setShipments(sh.data.data || []);
      setTransporters(tr.data.data || []);
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
          <h1 className="text-2xl font-bold text-ink">
            {isNew ? 'New Dispatch' : `Dispatch — ${header.dispatch_no}`}
          </h1>
          <p className="text-sm text-ink-secondary">Transport, LR & E-Way Bill details</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/dispatches')}>← Back</Button>
          {!isNew && <EwayBillButton sourceType="DISPATCH" sourceId={id} />}
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
            <JobSelect label="I/O No" value={header.io_no || ''} disabled={Boolean(header.shipment_id)} id="dsp-io"
              onPick={(j) => setHeader((p: any) => ({ ...p, io_no: j?.job_no ?? '', so_id: j ? j.id : p.so_id, ...(j?.buyer_id && !p.buyer_id ? { buyer_id: j.buyer_id } : {}) }))} />
            {header.shipment_id && <span className="text-micro text-indigo-600 font-medium">🔒 Inherited from Shipment</span>}
          </div>

          <Select label="Shipment Reference *" value={header.shipment_id || ''}
            onChange={e => handleShipmentSelect(e.target.value)}
            options={[{ value: '', label: '— Select Shipment —' }, ...shipments.map((s: any) => ({ value: s.id, label: `${s.shipment_no} (I/O: ${s.io_no || 'N/A'})` }))]} />
          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => {
              const so = salesOrders.find((x: any) => String(x.id) === e.target.value);
              setHeader((p: any) => ({ ...p, so_id: e.target.value ? Number(e.target.value) : null,
                ...(so && !p.shipment_id && !p.packing_list_id ? { io_no: so.job_no || so.io_no || so.so_no } : {}), ...(so?.buyer_id && !p.buyer_id ? { buyer_id: so.buyer_id } : {}) }));
            }}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Buyer / customer" value={header.buyer_id || ''}
            onChange={e => setField('buyer_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
        </div>
      </Card>

      <Card title="Transport Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Select label="Transporter" value={header.transporter_id || ''} hint={transporters.length ? undefined : 'Tick the Transporter role on the logistics partner (Business Partners)'}
            onChange={e => setField('transporter_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...transporters.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Input label="Vehicle No" value={header.vehicle_no || ''} onChange={e => setField('vehicle_no', e.target.value)}
            placeholder="TN 39 AB 1234" />
          <Input label="Driver Name" value={header.driver_name || ''} onChange={e => setField('driver_name', e.target.value)} />
          <Input label="LR No" value={header.lr_no || ''} onChange={e => setField('lr_no', e.target.value)} />
          <Input label="LR Date" type="date" value={header.lr_date || ''} onChange={e => setField('lr_date', e.target.value)} />
          <Input label="E-Way Bill No" value={header.eway_bill_no || ''} onChange={e => setField('eway_bill_no', e.target.value)}
            readOnly={Boolean(ewb)} hint={ewb ? 'Set by the e-way bill — change it there' : undefined} />
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
