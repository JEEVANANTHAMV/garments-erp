import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownUp } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
 '../../components/CrudPage';
import {
  PageHeader, SearchInput, Select, Input, Modal, Spinner, Badge, Textarea, useDebounced
} from '../../components/ui';
import { fmtDecimal, fmtDateTime, humanize } from '../../lib/format';

/* ------------------------------------------------------- Stock on hand */
export function StockPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [type, setType] = useState('');
  const [adjustOpen, setAdjustOpen] = useState(false);
  const debounced = useDebounced(search);

  const warehouses = useLookup('warehouses');
  const stock = useQuery({
    queryKey: ['stock', { debounced, warehouse, type }],
    queryFn: async () => (await http.get<{ data: any[] }>('/inventory/stock', {
      q: debounced || undefined, warehouse_id: warehouse || undefined,
      material_type: type || undefined, onlyInStock: false,
    })).data,
  });

  return (
    <>
      <PageHeader title="Stock on Hand" subtitle="Live balances derived from the stock ledger"
        actions={can('INVENTORY.ADJUST') && (
          <button className="btn-secondary" onClick={() => setAdjustOpen(true)}>
            <ArrowDownUp size={15} /> Stock adjustment
          </button>)} />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search item name…" />
        <Select placeholder="All warehouses" options={toOptions(warehouses.data)}
          value={warehouse} onChange={(e) => setWarehouse(e.target.value)} />
        <Select placeholder="All material types"
          options={['YARN','FABRIC','TRIM','FINISHED','WIP'].map((v) => ({ value: v, label: humanize(v) }))}
          value={type} onChange={(e) => setType(e.target.value)} />
      </div>

      <DataTable
        columns={[
          { key: 'item_code', header: 'Item code',
            render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.item_code}</span> },
          { key: 'item_name', header: 'Item', render: (r: any) => <span className="font-medium">{r.item_name}</span> },
          { key: 'material_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.material_type)}</Badge> },
          { key: 'warehouse_name', header: 'Warehouse' },
          { key: 'batch_no', header: 'Batch' },
          { key: 'total_in', header: 'In', align: 'right', render: (r: any) => fmtDecimal(r.total_in, 3) },
          { key: 'total_out', header: 'Out', align: 'right', render: (r: any) => fmtDecimal(r.total_out, 3) },
          { key: 'balance', header: 'Balance', align: 'right', render: (r: any) => {
            const b = Number(r.balance);
            return <span className={`font-semibold tabular-nums ${b <= 0 ? 'text-red-600' : 'text-slate-800'}`}>
              {fmtDecimal(b, 3)} {r.uom_code ?? ''}</span>; } },
        ]}
        rows={stock.data ?? []}
        loading={stock.isLoading} error={stock.error} onRetry={() => void stock.refetch()}
        rowKey={(r: any) => `${r.material_type}-${r.yarn_id}-${r.fabric_id}-${r.trim_id}-${r.sku_id}-${r.batch_id}-${r.warehouse_id}`}
        emptyTitle="No stock movements yet"
        emptyMessage="Stock appears here once goods are received or adjusted in." />

      <AdjustModal open={adjustOpen} onClose={() => setAdjustOpen(false)}
        onDone={() => { void stock.refetch(); toast('Stock adjusted'); }} />
    </>
  );
}

function AdjustModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<Record<string, any>>({ material_type: 'FABRIC' });
  const [busy, setBusy] = useState(false);
  const warehouses = useLookup('warehouses');
  const yarns = useLookup('yarns');
  const fabrics = useLookup('fabrics');
  const trims = useLookup('trims');
  const uoms = useLookup('uoms');

  const submit = async () => {
    setBusy(true);
    try {
      await http.post('/inventory/adjust', {
        warehouse_id: v.warehouse_id, material_type: v.material_type,
        yarn_id: v.material_type === 'YARN' ? v.material_id : null,
        fabric_id: v.material_type === 'FABRIC' ? v.material_id : null,
        trim_id: v.material_type === 'TRIM' ? v.material_id : null,
        qty: Number(v.qty), uom_id: v.uom_id, remarks: v.remarks,
      });
      onDone(); onClose(); setV({ material_type: 'FABRIC' });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Adjustment failed', 'error');
    } finally { setBusy(false); }
  };

  const options = v.material_type === 'YARN' ? toOptions(yarns.data)
                : v.material_type === 'FABRIC' ? toOptions(fabrics.data) : toOptions(trims.data);

  return (
    <Modal open={open} onClose={onClose} title="Stock adjustment" size="md"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={() => void submit()} disabled={busy}>
          {busy && <Spinner size={14} />}Post adjustment
        </button>
      </>}>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <Select label="Warehouse" required options={toOptions(warehouses.data)} placeholder="— Select —"
          value={v.warehouse_id ?? ''} onChange={(e) => setV((s) => ({ ...s, warehouse_id: e.target.value }))} />
        <Select label="Material type" required
          options={['YARN','FABRIC','TRIM'].map((m) => ({ value: m, label: humanize(m) }))}
          value={v.material_type} onChange={(e) => setV((s) => ({ ...s, material_type: e.target.value, material_id: '' }))} />
        <Select label="Material" required options={options} placeholder="— Select —" className="sm:col-span-2"
          value={v.material_id ?? ''} onChange={(e) => {
            const picked = (v.material_type === 'YARN' ? yarns.data : v.material_type === 'FABRIC' ? fabrics.data : trims.data)
              ?.find((x: any) => x.id === Number(e.target.value));
            setV((s) => ({ ...s, material_id: e.target.value, uom_id: picked?.base_uom ?? s.uom_id }));
          }} />
        <Input label="Quantity" type="number" step="0.001" required
          hint="Positive to add stock, negative to remove"
          value={v.qty ?? ''} onChange={(e) => setV((s) => ({ ...s, qty: e.target.value }))} />
        <Select label="UOM" required options={(uoms.data ?? []).map((u: any) => ({ value: u.id, label: u.code }))}
          placeholder="— Select —"
          value={v.uom_id ?? ''} onChange={(e) => setV((s) => ({ ...s, uom_id: e.target.value }))} />
        <Textarea className="sm:col-span-2" label="Reason" required
          placeholder="e.g. Cycle count correction, batch 2601"
          value={v.remarks ?? ''} onChange={(e) => setV((s) => ({ ...s, remarks: e.target.value }))} />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- Stock ledger */
export function StockLedgerPage() {
  const [warehouse, setWarehouse] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const warehouses = useLookup('warehouses');

  const ledger = useQuery({
    queryKey: ['ledger', { warehouse, type, page }],
    queryFn: async () => await http.get<{ data: any[]; pagination: any }>('/inventory/ledger', {
      warehouse_id: warehouse || undefined, material_type: type || undefined, page, pageSize: 50,
    }),
  });

  return (
    <>
      <PageHeader title="Stock Ledger" subtitle="Every movement in and out, append-only" />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Select placeholder="All warehouses" options={toOptions(warehouses.data)}
          value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setPage(1); }} />
        <Select placeholder="All material types"
          options={['YARN','FABRIC','TRIM','FINISHED','WIP'].map((v) => ({ value: v, label: humanize(v) }))}
          value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} />
      </div>

      <DataTable
        columns={[
          { key: 'txn_date', header: 'Date', render: (r: any) => fmtDateTime(r.txn_date) },
          { key: 'txn_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.txn_type)}</Badge> },
          { key: 'item_name', header: 'Item', render: (r: any) => <span className="font-medium">{r.item_name}</span> },
          { key: 'warehouse_name', header: 'Warehouse' },
          { key: 'batch_no', header: 'Batch' },
          { key: 'ref', header: 'Reference',
            render: (r: any) => <span className="text-[11.5px] text-slate-500">{r.ref_type} #{r.ref_id}</span> },
          { key: 'qty_in', header: 'In', align: 'right',
            render: (r: any) => Number(r.qty_in) > 0
              ? <span className="font-medium text-emerald-600">+{fmtDecimal(r.qty_in, 3)}</span> : '—' },
          { key: 'qty_out', header: 'Out', align: 'right',
            render: (r: any) => Number(r.qty_out) > 0
              ? <span className="font-medium text-red-600">−{fmtDecimal(r.qty_out, 3)}</span> : '—' },
          { key: 'uom_code', header: 'UOM' },
          { key: 'created_by_name', header: 'By' },
        ]}
        rows={ledger.data?.data ?? []}
        loading={ledger.isLoading} error={ledger.error} onRetry={() => void ledger.refetch()}
        rowKey={(r: any) => r.id}
        pagination={ledger.data?.pagination} onPage={setPage}
        emptyTitle="No movements recorded" />
    </>
  );
}
