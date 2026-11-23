import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { http } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '../../lib/format';
import { Button, Input, LoadingBlock, Modal, PageHeader, Select, Tabs } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { errText } from '../production/fabricProcess/shared';
import { OUTPUT_LABEL, SPLIT_REASON_LABEL } from './RollActions';

/**
 * Fabric roll cutting & reports (client doc "Fabric Roll Management" §4 / §12, voice note 23-Nov-2026):
 * split approvals (cutting loss above tolerance), split register, roll transfers and the roll reports —
 * GRN-wise received vs pieces now, remnants, ageing, cutting loss, roll book vs stock ledger, label prints.
 */
const n = (v: unknown) => Number(v ?? 0) || 0;
const kg = (v: unknown) => fmtDecimal(n(v), 3);
const STATUS_TONE: Record<string, string> = { POSTED: 'text-emerald-700', PENDING_APPROVAL: 'text-amber-700', REJECTED: 'text-red-700' };

type Col = { key: string; label: string; num?: boolean; kgCol?: boolean; date?: boolean; fmt?: (r: any) => string };
const REPORTS: Record<string, { label: string; help: string; cols: Col[] }> = {
  'grn-reconciliation': { label: 'GRN: received vs pieces now', help: 'Rolls and KG received on each GRN line never change; a cut only adds pieces. In store + issued + cutting loss explains every KG.', cols: [
    { key: 'grn_no', label: 'GRN' }, { key: 'grn_date', label: 'Date', date: true }, { key: 'supplier', label: 'Supplier' }, { key: 'fabric_name', label: 'Fabric' }, { key: 'lot_no', label: 'Lot' },
    { key: 'received_rolls', label: 'Rolls received', num: true }, { key: 'received_kg', label: 'KG received', kgCol: true }, { key: 'cut_rolls', label: 'Rolls cut', num: true },
    { key: 'pieces_now', label: 'Pieces now', num: true }, { key: 'pieces_in_store', label: 'Pieces in store', num: true }, { key: 'in_store_kg', label: 'KG in store', kgCol: true }, { key: 'cut_loss_kg', label: 'Cutting loss KG', kgCol: true }] },
  remnants: { label: 'Remnant pieces', help: 'Pieces left in store after a cut or a return — use them first.', cols: [
    { key: 'roll_no', label: 'Piece' }, { key: 'parent_roll_no', label: 'Cut from' }, { key: 'roll_origin', label: 'Origin' }, { key: 'fabric_name', label: 'Fabric' }, { key: 'lot_no', label: 'Lot' },
    { key: 'color_name', label: 'Colour' }, { key: 'job_no', label: 'Job' }, { key: 'warehouse_name', label: 'Store' }, { key: 'location_bin', label: 'Bin' }, { key: 'balance_kg', label: 'KG', kgCol: true },
    { key: 'qc_status', label: 'QC' }, { key: 'age_days', label: 'Age (days)', num: true }] },
  ageing: { label: 'Roll ageing', help: 'Every piece in store: days since the GRN and since its last movement.', cols: [
    { key: 'roll_no', label: 'Roll' }, { key: 'fabric_name', label: 'Fabric' }, { key: 'lot_no', label: 'Lot' }, { key: 'job_no', label: 'Job' }, { key: 'warehouse_name', label: 'Store' },
    { key: 'balance_kg', label: 'KG', kgCol: true }, { key: 'grn_no', label: 'GRN' }, { key: 'grn_date', label: 'GRN date', date: true }, { key: 'days_in_store', label: 'Days in store', num: true },
    { key: 'bucket', label: 'Bucket' }, { key: 'days_since_movement', label: 'Days since movement', num: true }] },
  'cut-loss': { label: 'Cutting loss / variance', help: 'Each split: KG on the roll vs the pieces; the loss is booked out of stock at the roll\'s cost.', cols: [
    { key: 'split_no', label: 'Split' }, { key: 'split_date', label: 'Date', date: true }, { key: 'parent_roll_no', label: 'Roll' }, { key: 'fabric_name', label: 'Fabric' },
    { key: 'reason_code', label: 'Reason', fmt: (r) => SPLIT_REASON_LABEL[r.reason_code] ?? r.reason_code }, { key: 'source_ref_no', label: 'DC' },
    { key: 'input_kg', label: 'Roll KG', kgCol: true }, { key: 'output_kg', label: 'Pieces KG', kgCol: true }, { key: 'variance_kg', label: 'Loss KG', kgCol: true }, { key: 'tolerance_kg', label: 'Tolerance', kgCol: true },
    { key: 'loss_value', label: 'Loss ₹', num: true }, { key: 'status', label: 'Status' }, { key: 'requested_by', label: 'By' }, { key: 'approved_by', label: 'Approved by' }] },
  'ledger-reconciliation': { label: 'Roll book vs stock ledger', help: 'Per fabric and store: KG on the rolls vs the stock ledger. A difference means a movement posted only one side.', cols: [
    { key: 'fabric_name', label: 'Fabric' }, { key: 'warehouse_name', label: 'Store' }, { key: 'pieces', label: 'Pieces', num: true }, { key: 'roll_kg', label: 'Roll KG', kgCol: true },
    { key: 'ledger_kg', label: 'Ledger KG', kgCol: true }, { key: 'difference_kg', label: 'Difference', kgCol: true }] },
  labels: { label: 'Label prints', help: 'Every roll label printed or reprinted (who, when, why).', cols: [
    { key: 'printed_at', label: 'When', fmt: (r) => fmtDateTime(r.printed_at) }, { key: 'roll_no', label: 'Roll' }, { key: 'print_kind', label: 'Kind' }, { key: 'reprint_reason', label: 'Reason' },
    { key: 'balance_kg', label: 'KG on label', kgCol: true }, { key: 'status', label: 'Status' }, { key: 'printed_by', label: 'By' }] },
};

function cell(c: Col, r: any) {
  if (c.fmt) return c.fmt(r);
  const v = r[c.key];
  if (v == null || v === '') return '—';
  if (c.date) return fmtDate(v);
  if (c.kgCol) return kg(v);
  if (c.num) return fmtDecimal(n(v), Number.isInteger(n(v)) ? 0 : 2);
  return String(v);
}

export default function FabricRollCuttingPage() {
  const nav = useNavigate();
  const toast = useToast(); const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'approvals';
  const setTab = (t: string) => setSp((p) => { p.set('tab', t); return p; }, { replace: true });
  const [report, setReport] = useState('grn-reconciliation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reject, setReject] = useState<any | null>(null);
  const [rejectWhy, setRejectWhy] = useState('');
  const [busy, setBusy] = useState(0);

  const pending = useQuery({ queryKey: ['roll-splits', 'PENDING_APPROVAL'], queryFn: async () => (await http.get<{ data: any[] }>('/inventory/fabric-rolls/splits', { status: 'PENDING_APPROVAL' })).data ?? [] });
  const splits = useQuery({ queryKey: ['roll-splits', 'all', from, to], enabled: tab === 'splits',
    queryFn: async () => (await http.get<{ data: any[] }>('/inventory/fabric-rolls/splits', { ...(from ? { from } : {}), ...(to ? { to } : {}) })).data ?? [] });
  const transfers = useQuery({ queryKey: ['roll-transfers'], enabled: tab === 'transfers', queryFn: async () => (await http.get<{ data: any[] }>('/inventory/fabric-rolls/transfers')).data ?? [] });
  const rep = useQuery({ queryKey: ['roll-report', report, from, to], enabled: tab === 'reports',
    queryFn: async () => (await http.get<{ data: any[] }>(`/inventory/fabric-rolls/reports/${report}`, { ...(from ? { from } : {}), ...(to ? { to } : {}) })).data ?? [] });
  const def = REPORTS[report];

  const approve = async (s: any) => {
    setBusy(s.id);
    try { const r = await http.post<any>(`/inventory/fabric-rolls/splits/${s.id}/approve`, {}); toast(r.message, 'success'); void qc.invalidateQueries(); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(0); }
  };
  const doReject = async () => {
    setBusy(reject.id);
    try { const r = await http.post<any>(`/inventory/fabric-rolls/splits/${reject.id}/reject`, { remarks: rejectWhy }); toast(r.message, 'success'); setReject(null); setRejectWhy(''); void qc.invalidateQueries(); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(0); }
  };
  const exportXlsx = () => {
    const rows = (rep.data ?? []).map((r) => Object.fromEntries(def.cols.map((c) => [c.label, c.fmt ? c.fmt(r) : (c.kgCol || c.num) ? n(r[c.key]) : (r[c.key] ?? '')])));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Report'); XLSX.writeFile(wb, `${report}.xlsx`);
  };
  const totals = useMemo(() => {
    const cols = def.cols.filter((c) => c.kgCol || (c.num && /rolls|pieces|value|₹/i.test(c.label)));
    return Object.fromEntries(cols.map((c) => [c.key, (rep.data ?? []).reduce((a, r) => a + n(r[c.key]), 0)]));
  }, [rep.data, def]);

  const table = (cols: string[], rows: any[], render: (r: any) => React.ReactNode, id: string, empty: string) => (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs" id={id}>
        <thead className="bg-surface-muted text-ink-secondary"><tr>{cols.map((h) => <th key={h} className="px-2 py-2 text-left whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>{rows.length ? rows.map(render) : <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-ink-muted">{empty}</td></tr>}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader breadcrumb={['Stores', 'Fabric Roll Stock', 'Roll Cutting']} title="Fabric Roll Cutting & Reports"
        subtitle="Cut rolls (pieces get their own roll nos), approvals for cutting loss above tolerance, roll moves and roll reports"
        actions={<Button variant="secondary" onClick={() => nav('/procurement/fabric/roll-stock')}>Fabric Roll Stock</Button>} />
      <div className="card mb-3 px-4 pt-2"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'approvals', label: 'Approvals', count: pending.data?.length ?? 0 }, { key: 'splits', label: 'Split register' },
        { key: 'transfers', label: 'Roll moves' }, { key: 'reports', label: 'Reports' }]} /></div>

      {tab === 'approvals' && (pending.isLoading ? <LoadingBlock /> : table(['Split', 'Requested', 'Roll', 'Fabric', 'Reason', 'Roll KG', 'Pieces', 'Loss KG', 'Tolerance', 'By', ''], pending.data ?? [], (s) => (
        <tr key={s.id} className="border-t border-surface-divider" data-split={s.split_no}>
          <td className="px-2 py-2 font-semibold tabular-nums">{s.split_no}</td><td className="px-2 py-2">{fmtDateTime(s.requested_at)}</td><td className="px-2 py-2 tabular-nums">{s.parent_roll_no}</td>
          <td className="px-2 py-2">{s.fabric_name}</td><td className="px-2 py-2">{SPLIT_REASON_LABEL[s.reason_code] ?? s.reason_code}{s.remarks ? ` — ${s.remarks}` : ''}</td>
          <td className="px-2 py-2 tabular-nums">{kg(s.input_kg)}</td><td className="px-2 py-2">{s.pieces}</td><td className="px-2 py-2 tabular-nums font-semibold text-amber-700">{kg(s.variance_kg)}</td>
          <td className="px-2 py-2 tabular-nums">{kg(s.tolerance_kg)}</td><td className="px-2 py-2">{s.requested_by_name}</td>
          <td className="px-2 py-2 whitespace-nowrap"><Button size="sm" onClick={() => approve(s)} loading={busy === s.id} data-approve={s.split_no}><Check size={13} /> Approve</Button>{' '}
            <Button size="sm" variant="secondary" onClick={() => setReject(s)} data-reject={s.split_no}><X size={13} /> Reject</Button></td>
        </tr>), 'split-approvals', 'Nothing waiting — splits within tolerance post straight away.'))}

      {(tab === 'splits' || tab === 'reports') && (
        <div className="card mb-3 flex flex-wrap items-end gap-2 p-3">
          {tab === 'reports' && <Select label="Report" className="w-72" value={report} onChange={(e) => setReport(e.target.value)} id="roll-report"
            options={Object.entries(REPORTS).map(([k, v]) => ({ value: k, label: v.label }))} />}
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          {tab === 'reports' && <Button variant="secondary" onClick={exportXlsx} disabled={!rep.data?.length}><Download size={14} /> Excel</Button>}
          {tab === 'reports' && <p className="basis-full text-caption text-ink-secondary">{def.help}</p>}
        </div>)}

      {tab === 'splits' && (splits.isLoading ? <LoadingBlock /> : table(['Split', 'Date', 'Roll', 'Fabric', 'Source', 'Reason', 'Roll KG', 'Pieces', 'Loss KG', 'Status', 'By', 'Approved by'], splits.data ?? [], (s) => (
        <tr key={s.id} className="border-t border-surface-divider" data-split={s.split_no}>
          <td className="px-2 py-2 font-semibold tabular-nums">{s.split_no}</td><td className="px-2 py-2">{fmtDate(s.split_date)}</td>
          <td className="px-2 py-2 tabular-nums"><button className="text-sky-700 hover:underline" onClick={() => nav(`/production/material-trace?roll=${encodeURIComponent(s.parent_roll_no)}`)}>{s.parent_roll_no}</button></td>
          <td className="px-2 py-2">{s.fabric_name}</td><td className="px-2 py-2">{s.source === 'MANUAL' ? 'Store' : `${s.source === 'PROCESS_DC' ? 'Process DC' : 'Job work DC'} ${s.source_ref_no ?? ''}`}</td>
          <td className="px-2 py-2">{SPLIT_REASON_LABEL[s.reason_code] ?? s.reason_code}</td><td className="px-2 py-2 tabular-nums">{kg(s.input_kg)}</td><td className="px-2 py-2">{s.pieces}</td>
          <td className="px-2 py-2 tabular-nums">{n(s.variance_kg) > 0 ? kg(s.variance_kg) : '—'}</td><td className={`px-2 py-2 font-semibold ${STATUS_TONE[s.status] ?? ''}`}>{String(s.status).replace('_', ' ')}</td>
          <td className="px-2 py-2">{s.requested_by_name}</td><td className="px-2 py-2">{s.approved_by_name ?? '—'}{s.approval_remarks ? ` (${s.approval_remarks})` : ''}</td>
        </tr>), 'split-register', 'No splits yet.'))}

      {tab === 'transfers' && (transfers.isLoading ? <LoadingBlock /> : table(['Move', 'Date', 'To store', 'Bin', 'Rolls', 'KG', 'Reason', 'By'], transfers.data ?? [], (t) => (
        <tr key={t.id} className="border-t border-surface-divider">
          <td className="px-2 py-2 font-semibold tabular-nums">{t.transfer_no}</td><td className="px-2 py-2">{fmtDate(t.transfer_date)}</td><td className="px-2 py-2">{t.to_warehouse}</td>
          <td className="px-2 py-2">{t.to_location_bin ?? '—'}</td><td className="px-2 py-2">{t.rolls}</td><td className="px-2 py-2 tabular-nums">{kg(t.total_kg)}</td><td className="px-2 py-2">{t.reason}</td><td className="px-2 py-2">{t.created_by_name}</td>
        </tr>), 'roll-transfers', 'No roll moves yet — select rolls on Fabric Roll Stock and choose "Move to store / bin".'))}

      {tab === 'reports' && (rep.isLoading ? <LoadingBlock /> : rep.error ? <div className="card p-4 text-red-700">{errText(rep.error)}</div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs" id="roll-report-table">
            <thead className="bg-surface-muted text-ink-secondary"><tr>{def.cols.map((c) => <th key={c.key} className={`px-2 py-2 whitespace-nowrap ${c.kgCol || c.num ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
            <tbody>
              {(rep.data ?? []).map((r, i) => <tr key={i} className={`border-t border-surface-divider ${report === 'ledger-reconciliation' && Math.abs(n(r.difference_kg)) > 0.0005 ? 'bg-amber-50' : ''}`}>
                {def.cols.map((c) => <td key={c.key} className={`px-2 py-1.5 ${c.kgCol || c.num ? 'text-right tabular-nums' : ''}`}>{c.key === 'output_type' ? (OUTPUT_LABEL[r[c.key]] ?? r[c.key]) : cell(c, r)}</td>)}</tr>)}
              {!rep.data?.length && <tr><td colSpan={def.cols.length} className="px-2 py-6 text-center text-ink-muted">Nothing to show.</td></tr>}
            </tbody>
            {!!rep.data?.length && Object.keys(totals).length > 0 && (
              <tfoot className="border-t-2 border-surface-border font-semibold"><tr>{def.cols.map((c, i) => <td key={c.key} className={`px-2 py-1.5 ${c.kgCol || c.num ? 'text-right tabular-nums' : ''}`}>
                {i === 0 ? `Total (${rep.data.length})` : c.key in totals ? (c.kgCol ? kg(totals[c.key]) : fmtDecimal(totals[c.key], 0)) : ''}</td>)}</tr></tfoot>)}
          </table>
        </div>))}

      <Modal open={!!reject} onClose={() => setReject(null)} size="sm" title={`Reject ${reject?.split_no ?? ''}`} subtitle="The roll stays as it is; the store can cut it again with the right weights."
        footer={<><Button variant="secondary" onClick={() => setReject(null)}>Cancel</Button><Button variant="danger" onClick={doReject} loading={!!busy} disabled={rejectWhy.trim().length < 3} id="btn-split-reject">Reject</Button></>}>
        <Input label="Reason *" value={rejectWhy} onChange={(e) => setRejectWhy(e.target.value)} id="split-reject-reason" placeholder="e.g. re-weigh the pieces" />
      </Modal>
    </>
  );
}
