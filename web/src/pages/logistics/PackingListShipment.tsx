import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/* ============================================================
   PACKING LISTS PAGE
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
          <p className="text-sm text-slate-500">Create and manage packing list documents</p>
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
            { key: 'total_qty', header: 'Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'gross_weight_kg', header: 'Gross Wt (KG)', align: 'right' as const, render: (r: any) => fmtDecimal(r.gross_weight_kg) },
            { key: 'total_cbm', header: 'CBM', align: 'right' as const, render: (r: any) => fmtDecimal(r.total_cbm, 3) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={statusColor(r.status)}>{r.status}</Badge> },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   PACKING LIST DETAIL
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
  const toast = useToast();

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
      toast('Packing list confirmed');
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
          <p className="text-sm text-slate-500">Frozen package-content document for shipment</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/packing-lists')}>← Back</Button>
          {!isNew && header.status === 'DRAFT' && (
            <Button variant="secondary" onClick={handleConfirm}>✓ Confirm</Button>
          )}
          {(isNew || header.status === 'DRAFT') && (
            <Button onClick={handleSave} loading={saving}>Save</Button>
          )}
        </div>
      </div>

      {/* Status Badge */}
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
          <Input label="I/O No" value={header.io_no} onChange={e => setField('io_no', e.target.value)} />

          <Select label="Sales Order" value={header.so_id || ''}
            onChange={e => setField('so_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...salesOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Packing" value={header.packing_id || ''}
            onChange={e => setField('packing_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...packings.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Buyer" value={header.buyer_id || ''}
            onChange={e => setField('buyer_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...buyers.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />

          <Select label="Shipment Type" value={header.shipment_type}
            onChange={e => setField('shipment_type', e.target.value)}
            options={[{ value: 'DOMESTIC', label: 'Domestic' }, { value: 'EXPORT', label: 'Export' }]} />
          <Input label="Destination" value={header.destination} onChange={e => setField('destination', e.target.value)} />
        </div>
      </Card>

      {/* Totals (read-only for existing) */}
      {!isNew && (
        <Card title="Totals">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtNumber(header.total_cartons)}</p>
              <p className="text-xs text-slate-500">Cartons</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-700">{fmtNumber(header.total_qty)}</p>
              <p className="text-xs text-slate-500">Total Qty</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.net_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Net Weight</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.gross_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Gross Weight</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.total_cbm, 3)}</p>
              <p className="text-xs text-slate-500">CBM</p>
            </div>
          </div>
        </Card>
      )}

      {/* Colour/Size Summary */}
      {summary.length > 0 && (
        <Card title="Colour × Size Summary">
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Colour</th>
                  <th className="pb-2">Size</th>
                  <th className="pb-2 text-right">Qty</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((row: any, i: number) => (
                  <tr key={i} className="border-b border-slate-50">
                    <td className="py-1.5">{row.color_name}</td>
                    <td className="py-1.5">{row.size_code}</td>
                    <td className="py-1.5 text-right font-medium">{fmtNumber(row.total_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Cartons */}
      {cartons.length > 0 && (
        <Card title={`Cartons (${cartons.length})`}>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Carton No</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Contents</th>
                  <th className="pb-2 text-right">Net Wt</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                </tr>
              </thead>
              <tbody>
                {cartons.map((c: any) => (
                  <tr key={c.id} className="border-b border-slate-50">
                    <td className="py-1.5 font-mono text-xs font-medium">{c.carton_no}</td>
                    <td className="py-1.5">{c.carton_type || '—'}</td>
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
    </div>
  );
}

/* ============================================================
   SHIPMENTS LIST
============================================================ */
export function ShipmentListPage() {
  const [shipments, setShipments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/shipments').then(r => setShipments(r.data.data)).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Shipments</h1>
          <p className="text-sm text-slate-500">Domestic & export shipment management</p>
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
            { key: 'shipment_type', header: 'Type', render: (r: any) => (
              <Badge color={r.shipment_type === 'EXPORT' ? 'blue' : 'slate'}>{r.shipment_type}</Badge>
            ) },
            { key: 'so_no', header: 'Sales Order' },
            { key: 'buyer_name', header: 'Buyer' },
            { key: 'mode', header: 'Mode', render: (r: any) => <Badge variant="outline">{r.mode}</Badge> },
            { key: 'destination', header: 'Destination' },
            { key: 'total_packages', header: 'Packages', align: 'right' as const, render: (r: any) => fmtNumber(r.total_packages) },
            { key: 'total_qty', header: 'Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'gross_weight_kg', header: 'Gross Wt', align: 'right' as const, render: (r: any) => fmtDecimal(r.gross_weight_kg) },
            { key: 'tracking_status', header: 'Status', render: (r: any) => {
              const colors: Record<string, string> = {
                BOOKED: 'slate', GATED_IN: 'yellow', LOADED: 'blue', SAILED: 'indigo',
                TRANSIT: 'amber', ARRIVED: 'emerald', DELIVERED: 'green',
              };
              return <Badge color={colors[r.tracking_status] || 'slate'}>{r.tracking_status}</Badge>;
            } },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   SHIPMENT DETAIL (CREATE / VIEW)
============================================================ */
export function ShipmentDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    shipment_no: '', io_no: '', so_id: null, packing_list_id: null,
    buyer_id: null, consignee_id: null, notify_party_id: null,
    shipment_type: 'DOMESTIC', mode: 'ROAD', incoterm: '',
    destination: '', country_id: null, freight_terms: '', remarks: '',
    // Export fields
    shipping_line: '', vessel_name: '', voyage_no: '', bl_no: '', bl_date: '',
    etd: '', eta: '', pol: '', pod: '',
  });
  const [packages, setPackages] = useState<any[]>([]);
  const [itemSummary, setItemSummary] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [availablePackages, setAvailablePackages] = useState<any[]>([]);
  const [selectedPkgs, setSelectedPkgs] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);

  // Lookups
  const [salesOrders, setSalesOrders] = useState<any[]>([]);
  const [buyers, setBuyers] = useState<any[]>([]);
  const toast = useToast();

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'),
      api.get('/lookups/parties'),
    ]).then(([so, pt]) => {
      setSalesOrders(so.data.data || []);
      setBuyers(pt.data.data || []);
    });

    if (isNew) {
      api.get('/available-packages').then(r => setAvailablePackages(r.data.data || []));
    }
  }, [isNew]);

  useEffect(() => {
    if (!isNew) {
      api.get(`/shipments/${id}`).then(r => {
        const d = r.data.data;
        setHeader(d);
        setPackages(d.packages || []);
        setItemSummary(d.itemSummary || []);
        setDocuments(d.documents || []);
      });
    }
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const togglePkg = (cartonId: number) => {
    setSelectedPkgs(prev =>
      prev.includes(cartonId) ? prev.filter(id => id !== cartonId) : [...prev, cartonId]
    );
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

  const isExport = header.shipment_type === 'EXPORT';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Shipment' : `Shipment — ${header.shipment_no}`}
          </h1>
          <p className="text-sm text-slate-500">
            {isExport ? 'Export shipment with container & documents' : 'Domestic shipment with LR & dispatch'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/shipments')}>← Back</Button>
          {isNew && <Button onClick={handleSave} loading={saving}>Create Shipment</Button>}
        </div>
      </div>

      {/* Header */}
      <Card title="Shipment Details">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
          <Input label="Shipment No" value={header.shipment_no || ''} disabled={!isNew}
            onChange={e => setField('shipment_no', e.target.value)} placeholder="Auto-generate" />
          <Input label="I/O No" value={header.io_no || ''} onChange={e => setField('io_no', e.target.value)} />
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

      {/* Export-specific fields */}
      {isExport && (
        <Card title="Export Details">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
            <Input label="Shipping Line" value={header.shipping_line || ''} onChange={e => setField('shipping_line', e.target.value)} />
            <Input label="Vessel Name" value={header.vessel_name || ''} onChange={e => setField('vessel_name', e.target.value)} />
            <Input label="Voyage No" value={header.voyage_no || ''} onChange={e => setField('voyage_no', e.target.value)} />
            <Input label="BL / AWB No" value={header.bl_no || ''} onChange={e => setField('bl_no', e.target.value)} />
            <Input label="BL Date" type="date" value={header.bl_date || ''} onChange={e => setField('bl_date', e.target.value)} />
            <Input label="Port of Loading" value={header.pol || ''} onChange={e => setField('pol', e.target.value)} />
            <Input label="Port of Discharge" value={header.pod || ''} onChange={e => setField('pod', e.target.value)} />
            <Input label="ETD" type="date" value={header.etd || ''} onChange={e => setField('etd', e.target.value)} />
            <Input label="ETA" type="date" value={header.eta || ''} onChange={e => setField('eta', e.target.value)} />
          </div>
        </Card>
      )}

      {/* Package Selection (New Shipment) */}
      {isNew && availablePackages.length > 0 && (
        <Card title={`Select Packages (${selectedPkgs.length} selected)`}>
          <div className="p-4 max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2 w-8"></th>
                  <th className="pb-2">Carton No</th>
                  <th className="pb-2">Packing</th>
                  <th className="pb-2">SKU Summary</th>
                  <th className="pb-2 text-right">Qty</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                </tr>
              </thead>
              <tbody>
                {availablePackages.map((p: any) => (
                  <tr key={p.id} className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${selectedPkgs.includes(p.id) ? 'bg-blue-50' : ''}`}
                    onClick={() => togglePkg(p.id)}>
                    <td className="py-1.5">
                      <input type="checkbox" checked={selectedPkgs.includes(p.id)} readOnly />
                    </td>
                    <td className="py-1.5 font-mono text-xs font-medium">{p.carton_no}</td>
                    <td className="py-1.5">{p.pack_no}</td>
                    <td className="py-1.5 text-xs text-slate-600">{p.sku_summary || '—'}</td>
                    <td className="py-1.5 text-right">{fmtNumber(p.content_qty)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.gross_weight_kg)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.cbm, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Allocated Packages (Existing Shipment) */}
      {!isNew && packages.length > 0 && (
        <Card title={`Allocated Packages (${packages.length})`}>
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Carton No</th>
                  <th className="pb-2">Packing</th>
                  <th className="pb-2 text-right">Qty</th>
                  <th className="pb-2 text-right">Gross Wt</th>
                  <th className="pb-2 text-right">CBM</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((p: any) => (
                  <tr key={p.id} className="border-b border-slate-50">
                    <td className="py-1.5 font-mono text-xs font-medium">{p.carton_no}</td>
                    <td className="py-1.5">{p.pack_no || '—'}</td>
                    <td className="py-1.5 text-right">{fmtNumber(p.allocated_qty)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_gross)}</td>
                    <td className="py-1.5 text-right">{fmtDecimal(p.carton_cbm, 3)}</td>
                    <td className="py-1.5"><Badge color={p.status === 'DISPATCHED' ? 'amber' : 'blue'}>{p.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Shipment Totals */}
      {!isNew && (
        <Card title="Shipment Totals">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtNumber(header.total_packages)}</p>
              <p className="text-xs text-slate-500">Packages</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-700">{fmtNumber(header.total_qty)}</p>
              <p className="text-xs text-slate-500">Total Qty</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.net_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Net Weight</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.gross_weight_kg)} KG</p>
              <p className="text-xs text-slate-500">Gross Weight</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-slate-800">{fmtDecimal(header.total_cbm, 3)}</p>
              <p className="text-xs text-slate-500">CBM</p>
            </div>
          </div>
        </Card>
      )}

      {/* Item Summary */}
      {!isNew && itemSummary.length > 0 && (
        <Card title="Item Summary">
          <div className="p-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="pb-2">Style</th>
                  <th className="pb-2">Colour</th>
                  <th className="pb-2">Size</th>
                  <th className="pb-2 text-right">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {itemSummary.map((it: any, idx: number) => (
                  <tr key={idx} className="border-b border-slate-50">
                    <td className="py-1.5 font-medium">{it.style_code}</td>
                    <td className="py-1.5">{it.color_name}</td>
                    <td className="py-1.5">{it.size_name}</td>
                    <td className="py-1.5 text-right font-medium">{fmtNumber(it.total_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Documents */}
      {!isNew && documents.length > 0 && (
        <Card title="Documents">
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
                {documents.map((d: any) => (
                  <tr key={d.id} className="border-b border-slate-50">
                    <td className="py-1.5">{d.doc_name}</td>
                    <td className="py-1.5 font-mono text-xs">{d.document_no || '—'}</td>
                    <td className="py-1.5">
                      <Badge color={d.status === 'VERIFIED' ? 'emerald' : d.status === 'PREPARED' ? 'blue' : 'slate'}>
                        {d.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Remarks */}
      <Card title="Remarks">
        <div className="p-4">
          <Textarea value={header.remarks || ''} rows={3}
            onChange={e => setField('remarks', e.target.value)}
            disabled={!isNew} />
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   DISPATCH LIST PAGE
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
            { key: 'transporter_name', header: 'Transporter' },
            { key: 'mode', header: 'Mode', render: (r: any) => <Badge variant="outline">{r.mode}</Badge> },
            { key: 'total_cartons', header: 'Cartons', align: 'right' as const, render: (r: any) => fmtNumber(r.total_cartons) },
            { key: 'status_label', header: 'Status', render: (r: any) => r.status_label ? <Badge>{r.status_label}</Badge> : '—' },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   DISPATCH DETAIL
============================================================ */
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
          <Input label="I/O No" value={header.io_no || ''} onChange={e => setField('io_no', e.target.value)} />

          <Select label="Shipment" value={header.shipment_id || ''}
            onChange={e => setField('shipment_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...shipments.map((s: any) => ({ value: s.id, label: s.shipment_no }))]} />
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
