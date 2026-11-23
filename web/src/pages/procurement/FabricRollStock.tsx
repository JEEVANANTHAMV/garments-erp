import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes, Search, Filter, RefreshCw, Edit3, PackageCheck, Layers, X, AlertCircle, Scissors, Printer, ArrowRightLeft, GitBranch, Workflow,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge, Modal, Input, Button, Select, useDebounced } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { errText } from '../production/fabricProcess/shared';
import { RollLabelModal, RollSplitModal, RollTransferModal } from './RollActions';

/**
 * Fabric roll stock (client doc "Fabric Roll Management", voice note 23-Nov-2026): one row per physical piece.
 * A roll the store cut into pieces is closed as SPLIT (hidden unless "show cut / merged rolls") and each piece is a
 * roll of its own, so the received rolls / KG never change and the pieces in store always match the floor.
 */
const n = (v: unknown) => Number(v ?? 0) || 0;
const ORIGIN_LABEL: Record<string, string> = { SPLIT: 'cut piece', RETURN: 'returned piece', MERGE: 'merged', TRANSFER: 'job transfer' };

export default function FabricRollStockPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [originFilter, setOriginFilter] = useState('');
  const [ioFilter, setIoFilter] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const [history, setHistory] = useState(false);
  const debouncedSearch = useDebounced(search.trim());
  const [sel, setSel] = useState<number[]>([]);
  const [splitId, setSplitId] = useState<number | null>(null);
  const [moveRolls, setMoveRolls] = useState<any[] | null>(null);
  const [labelIds, setLabelIds] = useState<{ ids: number[]; reprint: boolean } | null>(null);

  // QC / bin edit (the stock status follows transactions and is not edited by hand)
  const [editRoll, setEditRoll] = useState<any | null>(null);
  const [editBin, setEditBin] = useState('');
  const [editQc, setEditQc] = useState('ACCEPTED');
  const [editReason, setEditReason] = useState('');
  const [updating, setUpdating] = useState(false);

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debouncedSearch) p.search = debouncedSearch;
    if (qcFilter) p.qc_status = qcFilter;
    if (statusFilter) p.stock_status = statusFilter;
    if (originFilter) p.roll_origin = originFilter;
    if (ioFilter) p.io_no = ioFilter;
    if (styleFilter) p.style_id = styleFilter;
    if (history) p.include_history = '1';
    return p;
  }, [debouncedSearch, qcFilter, statusFilter, originFilter, ioFilter, styleFilter, history]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['fabric-rolls', params],
    queryFn: async () =>
      http.get<{ data: any[]; facets?: { io_nos: string[]; styles: { id: number; style_code: string; style_name: string }[] } }>('/fabric-rolls', params),
  });
  const summary = useQuery({ queryKey: ['fabric-rolls', 'summary'], queryFn: async () => (await http.get<{ data: any }>('/inventory/fabric-rolls/summary')).data });
  const rolls = data?.data ?? [];
  const facets = data?.facets ?? { io_nos: [], styles: [] };
  const errorMessage = error instanceof Error ? error.message : error ? 'Unable to load fabric rolls' : null;
  const hasFilters = !!(search || qcFilter || statusFilter || originFilter || ioFilter || styleFilter || history);
  const clearFilters = () => { setSearch(''); setQcFilter(''); setStatusFilter(''); setOriginFilter(''); setIoFilter(''); setStyleFilter(''); setHistory(false); };

  const isLive = (r: any) => !['SPLIT', 'MERGED', 'CLOSED'].includes(r.stock_status);
  const inStore = (r: any) => isLive(r) && n(r.balance_kg) > 0.0005;
  const listed = useMemo(() => {
    const live = rolls.filter(inStore);
    return { pieces: live.length, kg: live.reduce((s, r) => s + n(r.balance_kg), 0), meters: live.reduce((s, r) => s + (n(r.weight_kg) > 0 ? n(r.meters) * n(r.balance_kg) / n(r.weight_kg) : 0), 0) };
  }, [rolls]);
  const selected = rolls.filter((r) => sel.includes(Number(r.id)));
  const toggle = (id: number, on: boolean) => setSel(on ? [...new Set([...sel, id])] : sel.filter((x) => x !== id));

  const handleOpenEdit = (roll: any) => { setEditRoll(roll); setEditBin(roll.location_bin || ''); setEditQc(roll.qc_status || 'ACCEPTED'); setEditReason(''); };
  const handleSaveEdit = async () => {
    if (!editRoll) return;
    setUpdating(true);
    try {
      const r = await http.post<any>(`/fabric-rolls/${editRoll.id}/status`, { location_bin: editBin, qc_status: editQc, reason: editReason.trim() || undefined });
      toast(r.message ?? `Roll ${editRoll.roll_no} updated`, 'success');
      setEditRoll(null);
      void refetch(); void summary.refetch();
    } catch (e) { toast(errText(e), 'error'); } finally { setUpdating(false); }
  };

  const statusBadge = (st: string) => {
    switch (st) {
      case 'AVAILABLE': return <Badge tone="green">AVAILABLE</Badge>;
      case 'RESERVED': return <Badge tone="amber">RESERVED</Badge>;
      case 'PARTIAL': return <Badge tone="indigo">PART ISSUED</Badge>;
      case 'ISSUED': return <Badge tone="blue">ISSUED</Badge>;
      case 'SPLIT': return <Badge tone="violet">CUT INTO PIECES</Badge>;
      case 'MERGED': return <Badge tone="violet">MERGED</Badge>;
      case 'CLOSED': return <Badge tone="slate">CLOSED</Badge>;
      default: return <Badge tone="slate">{st}</Badge>;
    }
  };
  const s = summary.data;
  const kpi = (label: string, value: string, sub: string, tone: string, id?: string) => (
    <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm" id={id}>
      <div className="text-xs font-medium text-ink-secondary">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${tone}`}>{value}</div>
      <div className="text-caption text-ink-muted mt-0.5">{sub}</div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-surface-border pb-4">
        <div className="flex items-center gap-2">
          <span className="p-2 rounded-lg bg-sky-100 text-sky-700"><Boxes size={20} /></span>
          <div>
            <h1 className="text-xl font-bold text-ink tracking-tight">Fabric Roll Stock</h1>
            <p className="text-xs text-ink-secondary">One row per physical piece — cut a roll, move it, print its label; received rolls and KG never change</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={() => nav('/procurement/fabric/roll-cutting')} id="btn-roll-cutting"><GitBranch size={14} className="text-purple-600" /> Roll cutting &amp; reports
            {n(s?.pending_approvals) > 0 && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-micro font-semibold text-amber-800">{s.pending_approvals}</span>}</Button>
          <Button variant="outline" onClick={() => nav('/procurement/fabric/orders')}><Layers size={14} className="text-emerald-600" /> Fabric Orders</Button>
          <Button variant="outline" onClick={() => nav('/procurement/fabric/grn')}><PackageCheck size={14} className="text-emerald-600" /> Fabric GRNs</Button>
          <Button onClick={() => nav('/procurement/fabric/grn/new')}><PackageCheck size={14} /> Inward New Rolls</Button>
        </div>
      </div>

      {/* KPIs: received (purchase) never changes after a cut; pieces in store = what is on the floor */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {kpi('Rolls received', s ? fmtNumber(s.received_rolls) : '—', s ? `${fmtDecimal(s.received_kg, 3)} KG purchased / made` : 'GRN / process / opening', 'text-ink', 'kpi-received')}
        {kpi('Pieces in store', s ? fmtNumber(s.pieces_in_store) : '—', s ? `${fmtDecimal(s.balance_kg, 3)} KG in store` : '', 'text-emerald-600', 'kpi-pieces')}
        {kpi('Rolls cut', s ? fmtNumber(s.split_rolls) : '—', s ? `into ${fmtNumber(s.cut_pieces)} pieces · ${fmtNumber(s.remnants_in_store)} in store` : '', 'text-purple-600', 'kpi-cut')}
        {kpi('Cutting loss', s ? `${fmtDecimal(s.cut_loss_kg, 3)} KG` : '—', s ? `₹${fmtDecimal(s.cut_loss_value)} written off` : '', 'text-amber-600', 'kpi-loss')}
        {kpi('This list', `${fmtNumber(listed.pieces)} pcs`, `${fmtDecimal(listed.kg, 3)} KG · ${fmtDecimal(listed.meters)} M in store`, 'text-indigo-600', 'kpi-list')}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-surface-border/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-ink-muted" />
          <input type="text" placeholder="Roll no (yours or supplier's), cut from, lot, fabric, GRN, IO, style…" value={search} id="roll-search"
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-surface-input focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500" />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
          <Filter size={15} className="text-ink-muted" />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} id="roll-status-filter"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500">
            <option value="">All pieces</option>
            <option value="AVAILABLE">Available</option>
            <option value="RESERVED">Reserved / not accepted</option>
            <option value="PARTIAL">Part issued</option>
            <option value="ISSUED">Issued</option>
            <option value="CLOSED">Closed</option>
            <option value="SPLIT">Cut into pieces</option>
            <option value="MERGED">Merged</option>
          </select>
          <select value={originFilter} onChange={(e) => setOriginFilter(e.target.value)} id="roll-origin-filter"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500">
            <option value="">Any origin</option>
            <option value="RECEIPT">Received rolls</option>
            <option value="SPLIT">Cut pieces</option>
            <option value="RETURN">Returned pieces</option>
            <option value="MERGE">Merged rolls</option>
            <option value="TRANSFER">Job transfer pieces</option>
          </select>
          <select value={qcFilter} onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500">
            <option value="">All QC</option><option value="ACCEPTED">Accepted</option><option value="PENDING">Pending</option><option value="HOLD">Hold</option><option value="REJECTED">Rejected</option>
          </select>
          <select value={ioFilter} onChange={(e) => setIoFilter(e.target.value)} title="Internal Order No"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500">
            <option value="">All IO No</option>
            {facets.io_nos.map((io) => <option key={io} value={io}>{io}</option>)}
          </select>
          <select value={styleFilter} onChange={(e) => setStyleFilter(e.target.value)} title="Style"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500">
            <option value="">All Styles</option>
            {facets.styles.map((st) => <option key={st.id} value={String(st.id)}>{st.style_code}{st.style_name ? ` — ${st.style_name}` : ''}</option>)}
          </select>
          <label className="inline-flex items-center gap-1 text-xs text-ink-secondary"><input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} id="roll-show-history" /> Show cut / merged rolls</label>
          {hasFilters && <button onClick={clearFilters} className="inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-ink px-2 py-1"><X size={13} /> Clear</button>}
          <button onClick={() => { void refetch(); void summary.refetch(); }} className="p-1.5 rounded-lg border border-surface-input hover:bg-surface-muted text-ink-secondary transition" title="Refresh list">
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs" id="roll-bulk-bar">
          <b>{selected.length} roll(s) selected</b> · {fmtDecimal(selected.reduce((a, r) => a + n(r.balance_kg), 0), 3)} KG
          <Button size="sm" variant="secondary" onClick={() => setLabelIds({ ids: selected.map((r) => Number(r.id)), reprint: selected.some((r) => n(r.label_prints) > 0) })} id="btn-bulk-labels"><Printer size={13} /> Print labels</Button>
          <Button size="sm" variant="secondary" onClick={() => setMoveRolls(selected)} id="btn-bulk-move"><ArrowRightLeft size={13} /> Move to store / bin</Button>
          <button className="text-ink-secondary hover:text-ink" onClick={() => setSel([])}>Clear selection</button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-surface-border/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse" id="roll-table">
            <thead>
              <tr className="bg-surface-muted/80 text-ink-secondary font-semibold border-b border-surface-border">
                <th className="py-3 px-2"><input type="checkbox" title="Select all pieces in store" checked={rolls.filter(inStore).length > 0 && rolls.filter(inStore).every((r) => sel.includes(Number(r.id)))}
                  onChange={(e) => setSel(e.target.checked ? rolls.filter(inStore).map((r) => Number(r.id)) : [])} /></th>
                <th className="py-3 px-3">Roll No</th>
                <th className="py-3 px-3">Fabric Item</th>
                <th className="py-3 px-3">Lot / Shade</th>
                <th className="py-3 px-3 text-center">GSM / Dia</th>
                <th className="py-3 px-3 text-right">Meters</th>
                <th className="py-3 px-3 text-right">KG (received → in store)</th>
                <th className="py-3 px-3">Store / Bin</th>
                <th className="py-3 px-3">IO / Style</th>
                <th className="py-3 px-3">GRN / PO</th>
                <th className="py-3 px-3 text-center">QC</th>
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-divider text-ink">
              {isLoading ? (
                <tr><td colSpan={13} className="py-10 text-center text-ink-muted">Loading fabric roll stock...</td></tr>
              ) : errorMessage ? (
                <tr><td colSpan={13} className="py-12 text-center"><AlertCircle size={32} className="mx-auto text-red-400 mb-2" /><p className="text-sm font-medium text-ink">Unable to load fabric rolls</p><p className="text-xs text-red-600 mt-1">{errorMessage}</p></td></tr>
              ) : rolls.length === 0 ? (
                <tr><td colSpan={13} className="py-12 text-center text-ink-muted"><Boxes size={36} className="mx-auto text-ink-disabled mb-2" /><p className="text-sm font-medium text-ink-secondary">No fabric rolls found</p>
                  <p className="text-xs text-ink-muted mt-1">{hasFilters ? 'No roll matches these filters.' : 'Rolls are created when fabric GRNs are inwarded'}</p></td></tr>
              ) : rolls.map((r) => {
                const live = isLive(r);
                const canCut = inStore(r) && ['ACCEPTED', 'HOLD'].includes(r.qc_status);
                return (
                  <tr key={r.id} className={`hover:bg-surface-muted/70 transition ${live ? '' : 'opacity-60'}`} data-roll={r.roll_no}>
                    <td className="py-3 px-2">{inStore(r) && <input type="checkbox" checked={sel.includes(Number(r.id))} onChange={(e) => toggle(Number(r.id), e.target.checked)} />}</td>
                    <td className="py-3 px-3">
                      <div className="tabular-nums font-bold text-sky-700">{r.roll_no}</div>
                      {r.parent_roll_no && r.roll_origin !== 'RECEIPT' && <div className="text-micro text-purple-700">{ORIGIN_LABEL[r.roll_origin] ?? r.roll_origin} of {r.parent_roll_no}</div>}
                      {r.supplier_roll_no && <div className="text-micro text-ink-muted">supplier roll {r.supplier_roll_no}</div>}
                    </td>
                    <td className="py-3 px-3 font-semibold text-ink">{r.fabric_name || 'Fabric Item'}<div className="text-micro text-ink-muted font-normal">{r.fabric_code || ''}</div></td>
                    <td className="py-3 px-3 text-caption"><div className="tabular-nums">{r.lot_no || '—'}</div><div className="text-ink-secondary">{r.shade || r.color_name || ''}</div></td>
                    <td className="py-3 px-3 text-center text-ink-secondary text-caption">{r.gsm ?? '—'} / {r.dia || '—'}</td>
                    <td className="py-3 px-3 text-right font-medium text-emerald-700 tabular-nums">{r.meters != null ? `${fmtDecimal(r.meters)} m` : '—'}</td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      <div className="font-medium text-indigo-700">{fmtDecimal(r.balance_kg, 3)} kg</div>
                      {(Math.abs(n(r.original_kg) - n(r.balance_kg)) > 0.0005) && <div className="text-micro text-ink-secondary">of {fmtDecimal(r.original_kg, 3)} received</div>}
                    </td>
                    <td className="py-3 px-3"><div className="text-ink font-medium">{r.warehouse_name || '—'}</div>
                      <span className="tabular-nums text-micro bg-surface-header px-1 py-0.5 rounded text-ink-secondary">Bin: {r.location_bin || '—'}</span></td>
                    <td className="py-3 px-3 text-caption">
                      {r.internal_ir_no ? <button onClick={() => setIoFilter(r.internal_ir_no)} title="Filter by this IO" className="tabular-nums font-semibold text-indigo-700 hover:underline">{r.internal_ir_no}</button> : <span className="text-ink-disabled">No IO</span>}
                      {r.style_code && <div className="text-micro text-ink-secondary mt-0.5" title={r.style_name ?? ''}>{r.style_code}</div>}
                    </td>
                    <td className="py-3 px-3 text-caption">
                      {r.grn_no && <div onClick={() => nav(`/procurement/fabric/grn/${r.grn_id}`)} className="text-emerald-700 hover:underline cursor-pointer font-medium">{r.grn_no}</div>}
                      {r.po_no && <div className="text-ink-muted text-micro">{r.po_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-center"><span className={`text-micro px-1.5 py-0.5 rounded font-semibold ${r.qc_status === 'ACCEPTED' ? 'bg-emerald-100 text-emerald-800' : r.qc_status === 'REJECTED' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{r.qc_status}</span></td>
                    <td className="py-3 px-3 text-center">{statusBadge(r.stock_status)}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-center gap-1">
                        {canCut && <button onClick={() => setSplitId(Number(r.id))} className="p-1 text-ink-secondary hover:text-purple-700 hover:bg-purple-50 rounded" title="Cut this roll into pieces" data-action="split"><Scissors size={14} /></button>}
                        {inStore(r) && <button onClick={() => setLabelIds({ ids: [Number(r.id)], reprint: n(r.label_prints) > 0 })} className="p-1 text-ink-secondary hover:text-sky-700 hover:bg-sky-50 rounded" title={n(r.label_prints) > 0 ? 'Reprint label' : 'Print label'} data-action="label"><Printer size={14} /></button>}
                        <button onClick={() => nav(`/production/material-trace?roll=${encodeURIComponent(r.roll_no)}`)} className="p-1 text-ink-secondary hover:text-indigo-700 hover:bg-indigo-50 rounded" title="Trace / genealogy / history" data-action="trace"><Workflow size={14} /></button>
                        {live && <button onClick={() => handleOpenEdit(r)} className="p-1 text-ink-secondary hover:text-sky-700 hover:bg-sky-50 rounded" title="QC status / bin" data-action="edit"><Edit3 size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editRoll && (
        <Modal title={`Edit roll ${editRoll.roll_no}`} subtitle="QC status and rack / bin. The stock status follows the roll's transactions (GRN, DCs, cut, audit) and cannot be set by hand."
          open={!!editRoll} onClose={() => setEditRoll(null)} size="sm"
          footer={<><Button variant="secondary" onClick={() => setEditRoll(null)}>Cancel</Button><Button onClick={handleSaveEdit} loading={updating} id="btn-roll-edit-save">Save</Button></>}>
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-surface-muted rounded-lg text-ink grid grid-cols-2 gap-2 text-caption">
              <div>Fabric: <strong>{editRoll.fabric_name}</strong></div><div>Lot No: <strong>{editRoll.lot_no || '—'}</strong></div>
              <div>In store: <strong>{fmtDecimal(editRoll.balance_kg, 3)} kg</strong></div><div>Status: <strong>{editRoll.stock_status}</strong></div>
            </div>
            <Select label="QC status" value={editQc} onChange={(e) => setEditQc(e.target.value)} id="roll-edit-qc"
              options={['ACCEPTED', 'PENDING', 'HOLD', 'REJECTED'].map((x) => ({ value: x, label: x }))} />
            <Input label="Rack / location bin" value={editBin} onChange={(e) => setEditBin(e.target.value)} placeholder="e.g. FAB-RACK-02-B" id="roll-edit-bin" />
            <Input label={editQc !== editRoll.qc_status ? 'Reason *' : 'Reason'} value={editReason} onChange={(e) => setEditReason(e.target.value)} id="roll-edit-reason" placeholder="e.g. shade checked OK" />
          </div>
        </Modal>
      )}
      <RollSplitModal rollId={splitId} open={!!splitId} onClose={() => { setSplitId(null); void refetch(); void summary.refetch(); }} />
      <RollTransferModal rolls={moveRolls ?? []} open={!!moveRolls} onClose={() => setMoveRolls(null)} onDone={() => { setSel([]); void refetch(); }} />
      <RollLabelModal rollIds={labelIds?.ids ?? null} reprint={labelIds?.reprint} open={!!labelIds} onClose={() => { setLabelIds(null); void refetch(); }} />
    </div>
  );
}
