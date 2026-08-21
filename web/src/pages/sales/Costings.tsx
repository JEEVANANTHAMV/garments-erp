import { useState, useMemo } from 'react';
import { Plus, Calculator } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useList, useSave, useListState } from '../../hooks/useResource';
import { useLookup, toOptions, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, Modal, SearchInput, Input, Select, Textarea, Spinner,
  StatusBadge, useDebounced,
} from '../../components/ui';
import { fmtDate, fmtDecimal, today, toDateInput } from '../../lib/format';
import { ApiError } from '../../lib/api';

/** Cost heads in the order a merchandiser builds them up. */
const COST_HEADS = [
  { key: 'fabric_cost', label: 'Fabric' },
  { key: 'yarn_cost', label: 'Yarn' },
  { key: 'trim_cost', label: 'Trims' },
  { key: 'knitting_cost', label: 'Knitting' },
  { key: 'dyeing_cost', label: 'Dyeing' },
  { key: 'printing_cost', label: 'Printing' },
  { key: 'embroidery_cost', label: 'Embroidery' },
  { key: 'washing_cost', label: 'Washing' },
  { key: 'cutting_cost', label: 'Cutting' },
  { key: 'stitching_cost', label: 'Stitching' },
  { key: 'finishing_cost', label: 'Finishing' },
  { key: 'packing_cost', label: 'Packing' },
  { key: 'testing_cost', label: 'Testing' },
  { key: 'overhead_cost', label: 'Overheads' },
  { key: 'freight_cost', label: 'Freight' },
  { key: 'agent_commission', label: 'Agent commission' },
  { key: 'finance_cost', label: 'Finance cost' },
] as const;

export default function CostingsPage() {
  const { can } = useAuth();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'costing_date', dir: 'desc' });
  const debounced = useDebounced(search);
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [v, setV] = useState<Record<string, any>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const list = useList<any>('costings', { page, pageSize: 25, q: debounced || undefined, sort: sort.key, dir: sort.dir });
  const save = useSave('costings', 'Costing');
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');
  const statuses = useStatuses('COSTING');

  // Live totals as the user types — this is the point of the screen.
  const totalCost = useMemo(
    () => COST_HEADS.reduce((sum, h) => sum + (Number(v[h.key]) || 0), 0),
    [v]);
  const margin = Number(v.margin_pct) || 0;
  const suggestedFob = margin < 100 ? totalCost / (1 - margin / 100) : 0;
  const enteredFob = Number(v.fob_price) || 0;
  const actualMargin = enteredFob > 0 ? ((enteredFob - totalCost) / enteredFob) * 100 : 0;

  const openNew = () => {
    setEditId(null);
    setV({ costing_date: today(), version: 1, margin_pct: 15 });
    setErrors({}); setOpen(true);
  };

  const openEdit = (row: any) => {
    setEditId(row.id);
    setV({ ...row, costing_date: toDateInput(row.costing_date) });
    setErrors({}); setOpen(true);
  };

  const submit = async () => {
    setErrors({});
    try {
      await save.mutateAsync({ id: editId, body: { ...v, total_cost: totalCost.toFixed(4) } });
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    }
  };

  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));

  return (
    <>
      <PageHeader title="Costings" subtitle="Cost build-up per garment leading to the quoted FOB"
        actions={can('COSTING.CREATE') && (
          <button className="btn-primary" onClick={openNew}><Plus size={15} /> New Costing</button>)} />

      <SearchInput value={search} onChange={setSearch} placeholder="Search costing number…"
        className="mb-3 w-full max-w-sm" />

      <DataTable
        columns={[
          { key: 'costing_no', header: 'Costing no', sortable: true,
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.costing_no}</span> },
          { key: 'version', header: 'Ver', align: 'center' },
          { key: 'costing_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.costing_date) },
          { key: 'style_code', header: 'Style',
            render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
              <p className="text-[11px] text-slate-500">{r.style_name}</p></div> },
          { key: 'buyer_name', header: 'Buyer' },
          { key: 'total_cost', header: 'Total cost', align: 'right',
            render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_cost, 4)}` },
          { key: 'fob_price', header: 'FOB', align: 'right',
            render: (r: any) => <span className="font-medium text-slate-800">
              {r.currency_code ?? ''} {fmtDecimal(r.fob_price, 4)}</span> },
          { key: 'margin', header: 'Margin', align: 'right', render: (r: any) => {
            const fob = Number(r.fob_price), tc = Number(r.total_cost);
            if (!fob) return '—';
            const m = ((fob - tc) / fob) * 100;
            return <span className={m < 8 ? 'font-medium text-red-600' : m < 15 ? 'font-medium text-amber-600' : 'font-medium text-emerald-600'}>
              {m.toFixed(1)}%</span>;
          } },
          { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={can('COSTING.UPDATE') ? openEdit : undefined}
        sort={sort} onSort={onSort}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No costings yet"
        emptyMessage="Build a cost sheet to work out the FOB price for a style." />

      <Modal open={open} onClose={() => setOpen(false)} size="xl"
        title={editId ? 'Edit costing sheet' : 'New costing sheet'}
        footer={<>
          <button className="btn-secondary" onClick={() => setOpen(false)} disabled={save.isPending}>Cancel</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending && <Spinner size={14} />}{editId ? 'Save changes' : 'Create costing'}
          </button>
        </>}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3">
          <Input label="Costing no" hint="Blank to auto-generate" value={v.costing_no ?? ''}
            onChange={(e) => set('costing_no', e.target.value)} error={errors.costing_no} />
          <Input label="Version" type="number" value={v.version ?? 1}
            onChange={(e) => set('version', e.target.value)} />
          <Input label="Costing date" type="date" required value={v.costing_date ?? ''}
            onChange={(e) => set('costing_date', e.target.value)} error={errors.costing_date} />
          <Select label="Style" required options={toOptions(styles.data)} placeholder="— Select style —"
            value={v.style_id ?? ''} onChange={(e) => set('style_id', e.target.value)} error={errors.style_id} />
          <Select label="Buyer" options={toOptions(buyers.data)} placeholder="— Select buyer —"
            value={v.buyer_id ?? ''} onChange={(e) => set('buyer_id', e.target.value)} />
          <Select label="Currency" required options={toOptions(currencies.data)} placeholder="— Select —"
            value={v.currency_id ?? ''} onChange={(e) => set('currency_id', e.target.value)} error={errors.currency_id} />
          <Input label="Order quantity" type="number" value={v.order_qty ?? ''}
            onChange={(e) => set('order_qty', e.target.value)} />
          <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
            value={v.status_id ?? ''} onChange={(e) => set('status_id', e.target.value)} />
        </div>

        <div className="mt-5">
          <div className="mb-2.5 flex items-center gap-2">
            <Calculator size={15} className="text-brand-600" />
            <h3 className="text-[13.5px] font-semibold text-slate-800">Cost heads — per garment</h3>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            {COST_HEADS.map((h) => (
              <Input key={h.key} label={h.label} type="number" step="0.0001"
                value={v[h.key] ?? ''} onChange={(e) => set(h.key, e.target.value)} />
            ))}
          </div>
        </div>

        {/* Live summary */}
        <div className="mt-5 rounded-xl border border-brand-200 bg-brand-50/60 p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Total cost" value={totalCost.toFixed(4)} big />
            <div>
              <label className="label">Target margin %</label>
              <input className="input bg-white" type="number" step="0.01" value={v.margin_pct ?? ''}
                onChange={(e) => set('margin_pct', e.target.value)} />
            </div>
            <div>
              <label className="label">FOB price</label>
              <input className="input bg-white" type="number" step="0.0001" value={v.fob_price ?? ''}
                onChange={(e) => set('fob_price', e.target.value)} />
              {suggestedFob > 0 && (
                <button type="button" onClick={() => set('fob_price', suggestedFob.toFixed(4))}
                  className="mt-1 text-[11px] font-medium text-brand-600 hover:text-brand-700">
                  Use suggested {suggestedFob.toFixed(4)}
                </button>
              )}
            </div>
            <Stat label="Actual margin"
              value={enteredFob > 0 ? `${actualMargin.toFixed(2)}%` : '—'} big
              tone={enteredFob === 0 ? undefined : actualMargin < 8 ? 'red' : actualMargin < 15 ? 'amber' : 'green'} />
          </div>
          {enteredFob > 0 && v.order_qty ? (
            <p className="mt-3 border-t border-brand-200 pt-2.5 text-[12px] text-slate-600">
              Order value <span className="font-semibold text-slate-800">
                {(enteredFob * Number(v.order_qty)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </span> · contribution <span className="font-semibold text-slate-800">
                {((enteredFob - totalCost) * Number(v.order_qty)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </span>
            </p>
          ) : null}
        </div>

        <Textarea className="mt-4" label="Remarks" value={v.remarks ?? ''}
          onChange={(e) => set('remarks', e.target.value)} />
      </Modal>
    </>
  );
}

function Stat({ label, value, big, tone }: {
  label: string; value: string; big?: boolean; tone?: 'red' | 'amber' | 'green';
}) {
  const colors = { red: 'text-red-600', amber: 'text-amber-600', green: 'text-emerald-600' };
  return (
    <div>
      <p className="label">{label}</p>
      <p className={`${big ? 'text-[19px]' : 'text-[15px]'} font-semibold tabular-nums
        ${tone ? colors[tone] : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}
