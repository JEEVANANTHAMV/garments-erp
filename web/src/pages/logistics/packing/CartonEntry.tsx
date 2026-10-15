import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, ScanLine, Pencil } from 'lucide-react';
import { PageHeader, Card, Button, LoadingBlock, EmptyState } from '../../../components/ui';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { fmtNumber } from '../../../lib/format';
import { PackingNav, PkStatus, OrderPicker, useOrder, CartonEditor, printCartonLabel, errMsg, n, Stat } from './packingShared';

/** Screen C — Carton box entry: pick the order, add cartons with colour × size lines; edit while draft / open. */
export function CartonEntryPage() {
  const [sp, setSp] = useSearchParams();
  const orderId = sp.get('order') ? Number(sp.get('order')) : null;
  const order = useOrder(orderId);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const o = order.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['packing-order', orderId] }); qc.invalidateQueries({ queryKey: ['packing-orders'] }); };
  const openEdit = async (id: number) => {
    try { setEditing((await http.get<{ data: any }>(`/packing/cartons/${id}`)).data); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const cartons = (o?.cartons ?? []);
  const live = cartons.filter((c) => c.carton_status !== 'VOID');
  return (
    <div>
      <PageHeader title="Carton box entry" breadcrumb={['Logistics', 'Packing']}
        subtitle="Carton no, carton type, colour × size lines (per the buyer rule), pieces, polybags and weights. Verify, seal and post on the Verify / seal screen."
        actions={o && ['APPROVED', 'IN_PROGRESS'].includes(o.order_status) && can('PACKING.CREATE') && <Button id="new-carton" onClick={() => setEditing('new')}><Plus size={15} />New carton</Button>} />
      <PackingNav active="/logistics/packing/cartons" />
      <Card className="mb-4"><div className="grid items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,420px)_1fr]">
        <OrderPicker value={orderId} onChange={(v) => setSp(v ? { order: String(v) } : {})} />
        {o && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Planned" value={fmtNumber(o.planned_qty)} hint={`${o.planned_cartons} cartons`} />
          <Stat label="In cartons" value={fmtNumber(n(o.pieces_posted) + n(o.pieces_unposted))} hint={`${live.length} cartons`} />
          <Stat label="Posted" value={fmtNumber(o.pieces_posted)} tone="green" />
          <Stat label="Can add" value={fmtNumber((o.lines ?? []).reduce((a, l) => a + l.available, 0))} />
        </div>}
      </div></Card>
      {!orderId ? <EmptyState title="Pick a packing order" message="Cartons are packed against an approved packing order." /> : order.isLoading ? <LoadingBlock /> : (
        <Card>
          {!cartons.length ? <EmptyState title="No cartons yet" message="Use New carton to pack the first one." /> : (
            <table className="w-full text-[12.5px]" id="carton-list">
              <thead><tr><th className="th">#</th><th className="th">Carton no</th><th className="th">Contents</th><th className="th text-right">Pcs</th><th className="th text-right">Polybags (std)</th>
                <th className="th">Carton type</th><th className="th text-right">Gross kg</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>{cartons.map((c) => (
                <tr key={c.id} className={c.carton_status === 'VOID' ? 'opacity-50' : ''}>
                  <td className="td">{c.carton_seq}</td><td className="td font-mono">{c.carton_no}</td><td className="td">{c.contents}</td>
                  <td className="td text-right">{c.pieces_total}{n(c.is_partial) ? <span className="ml-1 text-[11px] text-amber-700">partial</span> : null}</td>
                  <td className="td text-right">{c.polybag_qty} <span className="text-slate-400">({c.std_polybag_qty})</span></td>
                  <td className="td">{c.carton_trim_name}</td><td className="td text-right">{c.gross_weight_kg ?? '—'}</td>
                  <td className="td"><PkStatus value={c.carton_status} posted={c.is_posted} /></td>
                  <td className="td whitespace-nowrap text-right">
                    {['DRAFT', 'OPEN'].includes(c.carton_status) && !n(c.is_posted) && can('PACKING.UPDATE') &&
                      <button className="mr-2 inline-flex items-center gap-1 text-slate-600 hover:underline" data-edit={c.carton_no} onClick={() => openEdit(c.id)}><Pencil size={13} />Edit</button>}
                    <Link className="mr-2 inline-flex items-center gap-1 text-brand-700 hover:underline" to={`/logistics/packing/verify?code=${encodeURIComponent(c.carton_no)}`}><ScanLine size={13} />Verify</Link>
                    {c.carton_status !== 'VOID' && <button className="inline-flex items-center gap-1 text-slate-600 hover:underline" onClick={() => printCartonLabel(c.id)}><Printer size={13} />Label</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      )}
      {editing && o && <CartonEditor order={o} carton={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); toast(`Carton ${c.carton_no} saved (${c.carton_status})`); refresh(); }} />}
    </div>
  );
}
