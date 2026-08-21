import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, PlayCircle, Truck } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import { CrudPage } from '../../components/CrudPage';
import {
  PageHeader, SearchInput, Select, Input, Modal, Spinner, Badge, StatusBadge,
  useDebounced, LoadingBlock, EmptyState,
} from '../../components/ui';
import { fmtNumber, fmtDecimal, fmtDate, humanize, today } from '../../lib/format';

/* -------------------------------------------------------- Purchase orders */
export function PurchaseOrdersPage() {
  return <CrudPage
    path="purchase-orders" title="Purchase Orders" permission="PURCHASE" singular="Purchase Order"
    subtitle="Material, job-work and service orders to suppliers"
    defaultSort={{ key: 'po_date', dir: 'desc' }}
    columns={[
      { key: 'po_no', header: 'PO no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.po_no}</span> },
      { key: 'po_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.po_date) },
      { key: 'supplier_name', header: 'Supplier' },
      { key: 'po_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.po_type)}</Badge> },
      { key: 'so_no', header: 'Against SO' },
      { key: 'grand_total', header: 'Value', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.grand_total, 2)}` },
      { key: 'delivery_date', header: 'Delivery', sortable: true, render: (r: any) => fmtDate(r.delivery_date) },
      { key: 'approval_state', header: 'State', render: (r: any) => <StatusBadge value={r.approval_state} /> },
    ]}
    filters={[
      { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
      { name: 'po_type', label: 'PO type', options: ['MATERIAL','JOBWORK','SERVICE','CAPEX'].map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'approval_state', label: 'State', options: ['DRAFT','PENDING','APPROVED','REJECTED','CLOSED','CANCELLED'].map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    modalSize="lg"
    fields={[
      { name: 'po_no', label: 'PO number', hint: 'Blank to auto-generate' },
      { name: 'po_date', label: 'PO date', type: 'date', required: true, defaultValue: today() },
      { name: 'supplier_id', label: 'Supplier', required: true, lookup: 'suppliers' },
      { name: 'po_type', label: 'PO type', options: ['MATERIAL','JOBWORK','SERVICE','CAPEX'].map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'MATERIAL' },
      { name: 'so_id', label: 'Against sales order', lookup: 'sales-orders' },
      { name: 'currency_id', label: 'Currency', required: true, lookup: 'currencies' },
      { name: 'exchange_rate', label: 'Exchange rate', type: 'number', defaultValue: 1 },
      { name: 'delivery_date', label: 'Delivery date', type: 'date' },
      { name: 'payment_terms', label: 'Payment terms' },
      { name: 'total_amount', label: 'Basic amount', type: 'number' },
      { name: 'tax_amount', label: 'Tax amount', type: 'number' },
      { name: 'grand_total', label: 'Grand total', type: 'number' },
      { name: 'approval_state', label: 'Approval state', options: ['DRAFT','PENDING','APPROVED','REJECTED','CLOSED','CANCELLED'].map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'DRAFT' },
      { name: 'status_id', label: 'Status', statusDomain: 'PURCHASE_ORDER' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* ------------------------------------------------------------- MRP runs */
export function MrpPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { page, setPage } = useListState();
  const [runOpen, setRunOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [soId, setSoId] = useState('');
  const [busy, setBusy] = useState(false);

  const salesOrders = useLookup('sales-orders');
  const list = useList<any>('mrp', { page, pageSize: 25 });

  const runMrp = async () => {
    if (!soId) { toast('Select a sales order', 'error'); return; }
    setBusy(true);
    try {
      const res = await http.post<{ data: any }>('/mrp/run', { so_id: Number(soId), run_date: today() });
      toast(`MRP run ${res.data.mrp_no} completed`);
      void qc.invalidateQueries({ queryKey: ['mrp'] });
      setRunOpen(false); setSoId(''); setDetailId(res.data.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'MRP run failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Material Requirement Planning"
        subtitle="Explode BOMs against orders, net off stock and open POs"
        actions={can('MRP.CREATE') && (
          <button className="btn-primary" onClick={() => setRunOpen(true)}>
            <PlayCircle size={15} /> Run MRP
          </button>)} />

      <DataTable
        columns={[
          { key: 'mrp_no', header: 'MRP no',
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.mrp_no}</span> },
          { key: 'run_date', header: 'Run date', render: (r: any) => fmtDate(r.run_date) },
          { key: 'so_no', header: 'Sales order' },
          { key: 'requirement_count', header: 'Requirements', align: 'right',
            render: (r: any) => <Badge tone="blue">{r.requirement_count}</Badge> },
          { key: 'remarks', header: 'Remarks' },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No MRP runs yet"
        emptyMessage="Run MRP against a sales order to work out what to buy." />

      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run MRP" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setRunOpen(false)} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void runMrp()} disabled={busy}>
            {busy && <Spinner size={14} />}Run MRP
          </button>
        </>}>
        <p className="mb-3 text-[13px] text-slate-600">
          MRP explodes each style's active BOM against the ordered quantity, then subtracts
          free stock and quantities already on open purchase orders.
        </p>
        <Select label="Sales order" required options={toOptions(salesOrders.data)}
          placeholder="— Select sales order —" value={soId} onChange={(e) => setSoId(e.target.value)} />
      </Modal>

      <MrpDetailModal id={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

function MrpDetailModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<number[]>([]);
  const [poOpen, setPoOpen] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [currencyId, setCurrencyId] = useState('');
  const [busy, setBusy] = useState(false);
  const suppliers = useLookup('suppliers');
  const currencies = useLookup('currencies');
  const { can } = useAuth();

  const detail = useQuery({
    queryKey: ['mrp', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/mrp/${id}`)).data,
    enabled: !!id,
  });

  const shortfalls = (detail.data?.requirements ?? []).filter((r: any) => Number(r.net_required) > 0);

  const createPo = async () => {
    if (!supplierId || !currencyId) { toast('Select supplier and currency', 'error'); return; }
    setBusy(true);
    try {
      const res = await http.post<{ data: any }>(`/mrp/${id}/create-po`, {
        supplier_id: Number(supplierId), currency_id: Number(currencyId),
        requirement_ids: selected,
      });
      toast(`Draft purchase order ${res.data.po_no} created`);
      setPoOpen(false); setSelected([]); onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create purchase order', 'error');
    } finally { setBusy(false); }
  };

  return (
    <>
      <Modal open={!!id} onClose={onClose} size="xl"
        title={`MRP ${detail.data?.mrp_no ?? ''} — net requirements`}
        footer={can('PURCHASE.CREATE') && selected.length > 0 ? (
          <button className="btn-primary" onClick={() => setPoOpen(true)}>
            <Truck size={15} /> Create PO for {selected.length} item{selected.length === 1 ? '' : 's'}
          </button>
        ) : <button className="btn-secondary" onClick={onClose}>Close</button>}>
        {detail.isLoading ? <LoadingBlock rows={6} /> : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 rounded-lg bg-surface-muted px-3.5 py-2.5 text-[12.5px]">
              <span>Sales order: <strong>{detail.data?.so_no ?? '—'}</strong></span>
              <span>Run date: <strong>{fmtDate(detail.data?.run_date)}</strong></span>
              <span>Total lines: <strong>{detail.data?.requirements?.length ?? 0}</strong></span>
              <span className="text-red-700">Shortfalls: <strong>{shortfalls.length}</strong></span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-surface-border">
              <table className="w-full">
                <thead><tr>
                  <th className="th w-10">
                    <input type="checkbox"
                      checked={selected.length > 0 && selected.length === shortfalls.length}
                      onChange={(e) => setSelected(e.target.checked ? shortfalls.map((r: any) => r.id) : [])}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600" />
                  </th>
                  <th className="th">Material</th><th className="th">Type</th>
                  <th className="th text-right">Gross</th><th className="th text-right">In stock</th>
                  <th className="th text-right">On order</th><th className="th text-right">Net required</th>
                  <th className="th">UOM</th>
                </tr></thead>
                <tbody>
                  {(detail.data?.requirements ?? []).map((r: any) => {
                    const net = Number(r.net_required);
                    const name = r.yarn_name || r.fabric_name || r.trim_name || '—';
                    return (
                      <tr key={r.id} className={net > 0 ? 'bg-red-50/40' : ''}>
                        <td className="td">
                          {net > 0 && (
                            <input type="checkbox" checked={selected.includes(r.id)}
                              onChange={(e) => setSelected((s) =>
                                e.target.checked ? [...s, r.id] : s.filter((x) => x !== r.id))}
                              className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600" />
                          )}
                        </td>
                        <td className="td font-medium">{name}</td>
                        <td className="td"><Badge tone="blue">{r.material_type}</Badge></td>
                        <td className="td text-right tabular-nums">{fmtDecimal(r.gross_required, 3)}</td>
                        <td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(r.in_stock, 3)}</td>
                        <td className="td text-right tabular-nums text-blue-700">{fmtDecimal(r.on_order, 3)}</td>
                        <td className="td text-right">
                          <span className={`font-semibold tabular-nums ${net > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                            {fmtDecimal(net, 3)}
                          </span>
                        </td>
                        <td className="td">{r.uom_code}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>

      <Modal open={poOpen} onClose={() => setPoOpen(false)} title="Create draft purchase order" size="sm"
        footer={<>
          <button className="btn-secondary" onClick={() => setPoOpen(false)} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void createPo()} disabled={busy}>
            {busy && <Spinner size={14} />}Create PO
          </button>
        </>}>
        <p className="mb-3 text-[13px] text-slate-600">
          {selected.length} shortfall line{selected.length === 1 ? '' : 's'} will be added to a draft PO
          priced at standard rates.
        </p>
        <div className="space-y-3.5">
          <Select label="Supplier" required options={toOptions(suppliers.data)} placeholder="— Select supplier —"
            value={supplierId} onChange={(e) => setSupplierId(e.target.value)} />
          <Select label="Currency" required options={toOptions(currencies.data)} placeholder="— Select currency —"
            value={currencyId} onChange={(e) => setCurrencyId(e.target.value)} />
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ GRN */
export function GrnPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { page, setPage, search, setSearch } = useListState();
  const debounced = useDebounced(search);
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['grns', { page, debounced }],
    queryFn: async () => await http.get<{ data: any[]; pagination: any }>('/inventory/grns', {
      page, pageSize: 25, q: debounced || undefined,
    }),
  });

  return (
    <>
      <PageHeader title="Goods Receipt Notes" subtitle="Receive material against purchase orders into stock"
        actions={can('GRN.CREATE') && (
          <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={15} /> New GRN</button>)} />

      <SearchInput value={search} onChange={setSearch} placeholder="Search GRN, DC or invoice number…"
        className="mb-3 w-full max-w-sm" />

      <DataTable
        columns={[
          { key: 'grn_no', header: 'GRN no',
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.grn_no}</span> },
          { key: 'grn_date', header: 'Date', render: (r: any) => fmtDate(r.grn_date) },
          { key: 'supplier_name', header: 'Supplier' },
          { key: 'po_no', header: 'Against PO' },
          { key: 'warehouse_name', header: 'Warehouse' },
          { key: 'supplier_dc_no', header: 'DC no' },
          { key: 'supplier_inv_no', header: 'Supplier invoice' },
          { key: 'line_count', header: 'Lines', align: 'right',
            render: (r: any) => <Badge tone="blue">{r.line_count}</Badge> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r: any) => r.id}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No goods receipts yet"
        emptyMessage="Receiving material posts accepted quantities straight into the stock ledger." />

      <GrnModal open={open} onClose={() => setOpen(false)}
        onDone={() => { void list.refetch(); void qc.invalidateQueries({ queryKey: ['stock'] }); }} />
    </>
  );
}

interface GrnLine {
  _key: string; material_type: 'YARN' | 'FABRIC' | 'TRIM';
  material_id: number | ''; received_qty: number | ''; accepted_qty: number | '';
  rejected_qty: number | ''; uom_id: number | ''; rate: number | '';
  new_batch_no: string; po_line_id?: number;
}
let gseq = 0;
const emptyGrnLine = (): GrnLine => ({
  _key: `g${++gseq}`, material_type: 'YARN', material_id: '', received_qty: '',
  accepted_qty: '', rejected_qty: 0, uom_id: '', rate: '', new_batch_no: '',
});

function GrnModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [head, setHead] = useState<Record<string, any>>({ grn_date: today() });
  const [lines, setLines] = useState<GrnLine[]>([emptyGrnLine()]);
  const [busy, setBusy] = useState(false);

  const suppliers = useLookup('suppliers');
  const warehouses = useLookup('warehouses');
  const purchaseOrders = useLookup('purchase-orders');
  const yarns = useLookup('yarns');
  const fabrics = useLookup('fabrics');
  const trims = useLookup('trims');
  const uoms = useLookup('uoms');

  const setLine = (k: string, patch: Partial<GrnLine>) =>
    setLines((s) => s.map((l) => (l._key === k ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        ...head,
        lines: lines.filter((l) => l.material_id && l.received_qty).map((l) => ({
          material_type: l.material_type,
          yarn_id: l.material_type === 'YARN' ? Number(l.material_id) : null,
          fabric_id: l.material_type === 'FABRIC' ? Number(l.material_id) : null,
          trim_id: l.material_type === 'TRIM' ? Number(l.material_id) : null,
          received_qty: Number(l.received_qty),
          accepted_qty: Number(l.accepted_qty || l.received_qty),
          rejected_qty: Number(l.rejected_qty) || 0,
          uom_id: Number(l.uom_id), rate: Number(l.rate) || 0,
          new_batch_no: l.new_batch_no || null,
        })),
      };
      if (!payload.lines.length) { toast('Add at least one receipt line', 'error'); setBusy(false); return; }
      const res = await http.post<{ data: any }>('/inventory/grns', payload);
      toast(`GRN ${res.data.grn_no} posted to stock`);
      onDone(); onClose();
      setHead({ grn_date: today() }); setLines([emptyGrnLine()]);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not post GRN', 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New goods receipt" size="xl"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy && <Spinner size={14} />}Post GRN
        </button>
      </>}>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
        <Input label="GRN no" hint="Blank to auto-generate" value={head.grn_no ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, grn_no: e.target.value }))} />
        <Input label="GRN date" type="date" required value={head.grn_date ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, grn_date: e.target.value }))} />
        <Select label="Supplier" required options={toOptions(suppliers.data)} placeholder="— Select —"
          value={head.supplier_id ?? ''} onChange={(e) => setHead((s) => ({ ...s, supplier_id: e.target.value }))} />
        <Select label="Warehouse" required options={toOptions(warehouses.data)} placeholder="— Select —"
          value={head.warehouse_id ?? ''} onChange={(e) => setHead((s) => ({ ...s, warehouse_id: e.target.value }))} />
        <Select label="Against PO" options={toOptions(purchaseOrders.data)} placeholder="— None —"
          value={head.po_id ?? ''} onChange={(e) => setHead((s) => ({ ...s, po_id: e.target.value }))} />
        <Input label="Supplier DC no" value={head.supplier_dc_no ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, supplier_dc_no: e.target.value }))} />
        <Input label="Supplier invoice no" value={head.supplier_inv_no ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, supplier_inv_no: e.target.value }))} />
        <Input label="Vehicle no" value={head.vehicle_no ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, vehicle_no: e.target.value }))} />
      </div>

      <h3 className="mb-2 mt-5 text-[13.5px] font-semibold text-slate-800">Receipt lines</h3>
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full">
          <thead><tr>
            <th className="th w-[100px]">Type</th><th className="th min-w-[180px]">Material</th>
            <th className="th w-[110px] text-right">Received</th><th className="th w-[110px] text-right">Accepted</th>
            <th className="th w-[100px] text-right">Rejected</th><th className="th w-[90px]">UOM</th>
            <th className="th w-[100px] text-right">Rate</th><th className="th w-[130px]">New batch</th>
            <th className="th w-10" />
          </tr></thead>
          <tbody>
            {lines.map((l) => {
              const src = l.material_type === 'YARN' ? yarns.data
                        : l.material_type === 'FABRIC' ? fabrics.data : trims.data;
              return (
                <tr key={l._key}>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.material_type}
                      onChange={(e) => setLine(l._key, {
                        material_type: e.target.value as GrnLine['material_type'], material_id: '' })}>
                      {['YARN','FABRIC','TRIM'].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.material_id}
                      onChange={(e) => {
                        const picked = (src ?? []).find((x: any) => x.id === Number(e.target.value));
                        setLine(l._key, {
                          material_id: e.target.value ? Number(e.target.value) : '',
                          uom_id: (picked?.base_uom as number) ?? l.uom_id,
                          rate: (picked?.std_rate as number) ?? l.rate,
                        });
                      }}>
                      <option value="">— Select —</option>
                      {toOptions(src).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5">
                    <input type="number" step="0.001" className="input py-1.5 text-right text-[12.5px]"
                      value={l.received_qty}
                      onChange={(e) => {
                        const q = e.target.value === '' ? '' : Number(e.target.value);
                        setLine(l._key, { received_qty: q, accepted_qty: l.accepted_qty === '' ? q : l.accepted_qty });
                      }} />
                  </td>
                  <td className="td p-1.5">
                    <input type="number" step="0.001" className="input py-1.5 text-right text-[12.5px]"
                      value={l.accepted_qty}
                      onChange={(e) => setLine(l._key, { accepted_qty: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </td>
                  <td className="td p-1.5">
                    <input type="number" step="0.001" className="input py-1.5 text-right text-[12.5px]"
                      value={l.rejected_qty}
                      onChange={(e) => setLine(l._key, { rejected_qty: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </td>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.uom_id}
                      onChange={(e) => setLine(l._key, { uom_id: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">—</option>
                      {(uoms.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5">
                    <input type="number" step="0.0001" className="input py-1.5 text-right text-[12.5px]"
                      value={l.rate}
                      onChange={(e) => setLine(l._key, { rate: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </td>
                  <td className="td p-1.5">
                    <input className="input py-1.5 text-[12.5px]" placeholder="Optional"
                      value={l.new_batch_no}
                      onChange={(e) => setLine(l._key, { new_batch_no: e.target.value })} />
                  </td>
                  <td className="td p-1.5 text-right">
                    <button onClick={() => setLines((s) => s.filter((x) => x._key !== l._key))}
                      disabled={lines.length === 1}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary btn-sm mt-2 w-full justify-center border-dashed"
        onClick={() => setLines((s) => [...s, emptyGrnLine()])}>
        <Plus size={14} /> Add line
      </button>
      <p className="mt-2 text-[11.5px] text-slate-500">
        Accepted quantities post into the stock ledger and update the PO's received quantity.
      </p>
    </Modal>
  );
}

/* -------------------------------------------------------- Material issue */
export function MaterialIssuePage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { page, setPage, search, setSearch } = useListState();
  const debounced = useDebounced(search);
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ['issues', { page, debounced }],
    queryFn: async () => await http.get<{ data: any[]; pagination: any }>('/inventory/issues', {
      page, pageSize: 25, q: debounced || undefined,
    }),
  });

  return (
    <>
      <PageHeader title="Material Issue" subtitle="Issue raw material from stores to production"
        actions={can('ISSUE.CREATE') && (
          <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={15} /> New Issue</button>)} />

      <SearchInput value={search} onChange={setSearch} placeholder="Search issue number…"
        className="mb-3 w-full max-w-sm" />

      <DataTable
        columns={[
          { key: 'issue_no', header: 'Issue no',
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.issue_no}</span> },
          { key: 'issue_date', header: 'Date', render: (r: any) => fmtDate(r.issue_date) },
          { key: 'warehouse_name', header: 'From warehouse' },
          { key: 'po_prod_no', header: 'Work order' },
          { key: 'unit_name', header: 'To unit' },
          { key: 'line_count', header: 'Lines', align: 'right',
            render: (r: any) => <Badge tone="blue">{r.line_count}</Badge> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r: any) => r.id}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No material issues yet"
        emptyMessage="Issuing material reduces stock and feeds consumption reporting." />

      <IssueModal open={open} onClose={() => setOpen(false)}
        onDone={() => { void list.refetch(); void qc.invalidateQueries({ queryKey: ['stock'] }); }} />
    </>
  );
}

function IssueModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [head, setHead] = useState<Record<string, any>>({ issue_date: today() });
  const [lines, setLines] = useState<GrnLine[]>([emptyGrnLine()]);
  const [busy, setBusy] = useState(false);

  const warehouses = useLookup('warehouses');
  const prodOrders = useLookup('production-orders');
  const units = useLookup('units');
  const yarns = useLookup('yarns');
  const fabrics = useLookup('fabrics');
  const trims = useLookup('trims');
  const uoms = useLookup('uoms');

  const setLine = (k: string, patch: Partial<GrnLine>) =>
    setLines((s) => s.map((l) => (l._key === k ? { ...l, ...patch } : l)));

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        ...head,
        lines: lines.filter((l) => l.material_id && l.received_qty).map((l) => ({
          material_type: l.material_type,
          yarn_id: l.material_type === 'YARN' ? Number(l.material_id) : null,
          fabric_id: l.material_type === 'FABRIC' ? Number(l.material_id) : null,
          trim_id: l.material_type === 'TRIM' ? Number(l.material_id) : null,
          issued_qty: Number(l.received_qty), uom_id: Number(l.uom_id),
        })),
      };
      if (!payload.lines.length) { toast('Add at least one issue line', 'error'); setBusy(false); return; }
      const res = await http.post<{ data: any }>('/inventory/issues', payload);
      toast(`Material issue ${res.data.issue_no} posted`);
      onDone(); onClose();
      setHead({ issue_date: today() }); setLines([emptyGrnLine()]);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not post issue', 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New material issue" size="lg"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy && <Spinner size={14} />}Post issue
        </button>
      </>}>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Input label="Issue no" hint="Blank to auto-generate" value={head.issue_no ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, issue_no: e.target.value }))} />
        <Input label="Issue date" type="date" required value={head.issue_date ?? ''}
          onChange={(e) => setHead((s) => ({ ...s, issue_date: e.target.value }))} />
        <Select label="From warehouse" required options={toOptions(warehouses.data)} placeholder="— Select —"
          value={head.warehouse_id ?? ''} onChange={(e) => setHead((s) => ({ ...s, warehouse_id: e.target.value }))} />
        <Select label="Work order" options={toOptions(prodOrders.data)} placeholder="— None —"
          value={head.prod_order_id ?? ''} onChange={(e) => setHead((s) => ({ ...s, prod_order_id: e.target.value }))} />
        <Select label="Issue to unit" options={toOptions(units.data)} placeholder="— None —"
          value={head.issued_to_unit ?? ''} onChange={(e) => setHead((s) => ({ ...s, issued_to_unit: e.target.value }))} />
      </div>

      <h3 className="mb-2 mt-5 text-[13.5px] font-semibold text-slate-800">Issue lines</h3>
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full">
          <thead><tr>
            <th className="th w-[100px]">Type</th><th className="th min-w-[200px]">Material</th>
            <th className="th w-[120px] text-right">Quantity</th><th className="th w-[90px]">UOM</th>
            <th className="th w-10" />
          </tr></thead>
          <tbody>
            {lines.map((l) => {
              const src = l.material_type === 'YARN' ? yarns.data
                        : l.material_type === 'FABRIC' ? fabrics.data : trims.data;
              return (
                <tr key={l._key}>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.material_type}
                      onChange={(e) => setLine(l._key, {
                        material_type: e.target.value as GrnLine['material_type'], material_id: '' })}>
                      {['YARN','FABRIC','TRIM'].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.material_id}
                      onChange={(e) => {
                        const picked = (src ?? []).find((x: any) => x.id === Number(e.target.value));
                        setLine(l._key, {
                          material_id: e.target.value ? Number(e.target.value) : '',
                          uom_id: (picked?.base_uom as number) ?? l.uom_id });
                      }}>
                      <option value="">— Select —</option>
                      {toOptions(src).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5">
                    <input type="number" step="0.001" className="input py-1.5 text-right text-[12.5px]"
                      value={l.received_qty}
                      onChange={(e) => setLine(l._key, { received_qty: e.target.value === '' ? '' : Number(e.target.value) })} />
                  </td>
                  <td className="td p-1.5">
                    <select className="input py-1.5 text-[12.5px]" value={l.uom_id}
                      onChange={(e) => setLine(l._key, { uom_id: e.target.value ? Number(e.target.value) : '' })}>
                      <option value="">—</option>
                      {(uoms.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}
                    </select>
                  </td>
                  <td className="td p-1.5 text-right">
                    <button onClick={() => setLines((s) => s.filter((x) => x._key !== l._key))}
                      disabled={lines.length === 1}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary btn-sm mt-2 w-full justify-center border-dashed"
        onClick={() => setLines((s) => [...s, emptyGrnLine()])}>
        <Plus size={14} /> Add line
      </button>
      <p className="mt-2 text-[11.5px] text-slate-500">
        The issue is rejected if any line exceeds the available balance in that warehouse.
      </p>
    </Modal>
  );
}
