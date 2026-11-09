/**
 * Accounts → Reports (spec §13): trial balance, ledger (cash / bank book), day book, P&L and balance sheet in Tally's
 * layout, bill-wise payables / receivables with ageing, job-wise books. Excel on every report.
 * Order-wise profit (budget vs actual per IO) stays in Reports → Budget vs Actuals — the job-wise books link to it.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { PageHeader, Button, Input, Tabs, LoadingBlock, ErrorState, Select } from '../../components/ui';
import { http } from '../../lib/api';
import { exportRowsToExcel, type ReportColumn } from '../reports/clientReportKit';
import { inr, drcr, useLedgerOptions, LedgerSelect, todayIst, fyStart, VOUCHER_TYPE_LABEL } from './accShared';

const TABS = [
  { key: 'tb', label: 'Trial balance' }, { key: 'ledger', label: 'Ledger' }, { key: 'daybook', label: 'Day book' }, { key: 'pl', label: 'Profit & loss' },
  { key: 'bs', label: 'Balance sheet' }, { key: 'payables', label: 'Payables' }, { key: 'receivables', label: 'Receivables' }, { key: 'jobs', label: 'Job-wise books' },
];

export function AccountsReportsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'tb';
  const from = sp.get('from') ?? fyStart();
  const to = sp.get('to') ?? todayIst();
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const asOf = tab === 'bs' || tab === 'payables' || tab === 'receivables';
  return (
    <div>
      <PageHeader title="Books" breadcrumb={['Accounts', 'Reports']} subtitle="From posted vouchers. Click any amount to drill down to the voucher."
        actions={<div className="flex items-end gap-2">
          {!asOf && <label className="text-caption text-ink-secondary">From<Input id="acc-rep-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></label>}
          <label className="text-caption text-ink-secondary">{asOf ? 'As on' : 'To'}<Input id="acc-rep-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></label>
        </div>} />
      <Tabs tabs={TABS} active={tab} onChange={(k) => set('tab', k)} />
      <div className="mt-3">
        {tab === 'tb' && <TrialBalance from={from} to={to} />}
        {tab === 'ledger' && <LedgerReport from={from} to={to} ledgerId={sp.get('ledger_id')} onLedger={(id) => set('ledger_id', id ? String(id) : '')} />}
        {tab === 'daybook' && <DayBook from={from} to={to} />}
        {tab === 'pl' && <ProfitLoss from={from} to={to} />}
        {tab === 'bs' && <BalanceSheet to={to} />}
        {(tab === 'payables' || tab === 'receivables') && <Outstanding kind={tab} to={to} />}
        {tab === 'jobs' && <JobBooks from={from} to={to} />}
      </div>
    </div>
  );
}

function useReport<T>(path: string, params: Record<string, unknown>, enabled = true) {
  return useQuery({ queryKey: ['accounts', 'report', path, params], enabled, queryFn: async () => (await http.get<{ data: T }>(`/accounts/reports/${path}`, params)).data });
}
function Shell({ q, children, onExcel, note }: { q: { isLoading: boolean; error: unknown }; children: ReactNode; onExcel?: () => void; note?: ReactNode }) {
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="card overflow-x-auto">
      {(onExcel || note) && <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
        <div className="text-body text-ink-secondary">{note}</div>
        {onExcel && <Button size="sm" variant="secondary" onClick={onExcel}><FileSpreadsheet size={14} />Excel</Button>}
      </div>}
      {children}
    </div>
  );
}
const M = (v: unknown) => <span className="tabular-nums">{inr(v, true)}</span>;

// ---------------------------------------------------------------- trial balance (grouped)
function TrialBalance({ from, to }: { from: string; to: string }) {
  const nav = useNavigate();
  const q = useReport<any>('trial-balance', { from, to });
  const [open, setOpen] = useState<Set<number>>(new Set());
  const d = q.data;
  const tree = useMemo(() => {
    if (!d) return [];
    const gs: any[] = d.groups;
    const byParent = new Map<number | null, any[]>();
    for (const g of gs) { const p = g.parent_id ? Number(g.parent_id) : null; byParent.set(p, [...(byParent.get(p) ?? []), g]); }
    const ledgersOf = new Map<number, any[]>();
    for (const l of d.ledgers) ledgersOf.set(Number(l.group_id), [...(ledgersOf.get(Number(l.group_id)) ?? []), l]);
    const sum = (gid: number): { opening: number; dr: number; cr: number; closing: number } => {
      const own = (ledgersOf.get(gid) ?? []).reduce((t, l) => ({ opening: t.opening + l.opening, dr: t.dr + l.dr, cr: t.cr + l.cr, closing: t.closing + l.closing }), { opening: 0, dr: 0, cr: 0, closing: 0 });
      for (const c of byParent.get(gid) ?? []) { const s = sum(Number(c.id)); own.opening += s.opening; own.dr += s.dr; own.cr += s.cr; own.closing += s.closing; }
      return own;
    };
    const out: { kind: 'g' | 'l'; depth: number; row: any; t?: any }[] = [];
    const walk = (p: number | null, depth: number) => {
      for (const g of byParent.get(p) ?? []) {
        const t = sum(Number(g.id));
        if (!t.opening && !t.dr && !t.cr) continue;
        out.push({ kind: 'g', depth, row: g, t });
        if (open.has(Number(g.id))) {
          walk(Number(g.id), depth + 1);
          for (const l of ledgersOf.get(Number(g.id)) ?? []) out.push({ kind: 'l', depth: depth + 1, row: l });
        }
      }
    };
    walk(null, 0);
    return out;
  }, [d, open]);
  const excel = () => exportRowsToExcel(`trial-balance-${to}`, 'Trial balance',
    [{ key: 'group_name', header: 'Group' }, { key: 'ledger_name', header: 'Ledger' }, { key: 'opening', header: 'Opening (Dr +)', type: 'money', total: true },
      { key: 'dr', header: 'Debit', type: 'money', total: true }, { key: 'cr', header: 'Credit', type: 'money', total: true }, { key: 'closing', header: 'Closing (Dr +)', type: 'money', total: true }] as ReportColumn[],
    d?.ledgers ?? [], `Trial balance ${from} to ${to}`);
  const toggle = (id: number) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Shell q={q} onExcel={excel} note={d && (d.balanced ? <span className="text-status-success-text">Debits equal credits</span>
      : <span className="text-status-error-text">Difference in opening balances {drcr(d.difference_in_opening)}</span>)}>
      <table className="w-full" id="acc-tb">
        <thead><tr><th className="th">Particulars</th><th className="th text-right">Opening</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th text-right">Closing</th></tr></thead>
        <tbody>
          {tree.map((x) => x.kind === 'g' ? (
            <tr key={`g${x.row.id}`} className="row-hover cursor-pointer" onClick={() => toggle(Number(x.row.id))}>
              <td className="td font-semibold" style={{ paddingLeft: `${12 + x.depth * 18}px` }}>{open.has(Number(x.row.id)) ? '▾' : '▸'} {x.row.group_name}</td>
              <td className="td text-right tabular-nums">{drcr(x.t.opening)}</td><td className="td text-right">{M(x.t.dr)}</td><td className="td text-right">{M(x.t.cr)}</td>
              <td className="td text-right font-semibold tabular-nums">{drcr(x.t.closing)}</td>
            </tr>) : (
            <tr key={`l${x.row.id}`} className="row-hover cursor-pointer" onClick={() => nav(`/accounts/reports?tab=ledger&ledger_id=${x.row.id}&from=${from}&to=${to}`)}>
              <td className="td" style={{ paddingLeft: `${12 + x.depth * 18}px` }}>{x.row.ledger_name}</td>
              <td className="td text-right tabular-nums">{drcr(x.row.opening)}</td><td className="td text-right">{M(x.row.dr)}</td><td className="td text-right">{M(x.row.cr)}</td>
              <td className="td text-right tabular-nums">{drcr(x.row.closing)}</td>
            </tr>))}
        </tbody>
        {d && <tfoot><tr className="border-t border-surface-border font-semibold">
          <td className="td">Total</td><td className="td text-right tabular-nums">{drcr(d.totals.opening)}</td><td className="td text-right">{M(d.totals.dr)}</td><td className="td text-right">{M(d.totals.cr)}</td>
          <td className="td text-right tabular-nums">{drcr(d.totals.closing)}</td></tr></tfoot>}
      </table>
    </Shell>
  );
}

// ---------------------------------------------------------------- ledger
function LedgerReport({ from, to, ledgerId, onLedger }: { from: string; to: string; ledgerId: string | null; onLedger: (id: number | null) => void }) {
  const nav = useNavigate();
  const leds = useLedgerOptions();
  const q = useReport<any>('ledger', { from, to, ledger_id: ledgerId }, !!ledgerId);
  const d = q.data;
  const excel = () => d && exportRowsToExcel(`ledger-${d.ledger.ledger_name}-${to}`.slice(0, 80), 'Ledger',
    [{ key: 'voucher_date', header: 'Date', type: 'date' }, { key: 'voucher_no', header: 'Voucher' }, { key: 'type_code', header: 'Type' }, { key: 'against', header: 'Particulars' },
      { key: 'ref_no', header: 'Ref' }, { key: 'bill_ref_no', header: 'Bill ref' }, { key: 'narration', header: 'Narration' }, { key: 'debit', header: 'Debit', type: 'money', total: true },
      { key: 'credit', header: 'Credit', type: 'money', total: true }, { key: 'balance', header: 'Balance (Dr +)', type: 'money' }] as ReportColumn[], d.rows, `${d.ledger.ledger_name} ${from} to ${to} · opening ${drcr(d.opening)}`);
  return (
    <div className="space-y-3">
      <div className="max-w-xl"><LedgerSelect id="acc-rep-ledger" value={ledgerId ? Number(ledgerId) : null} options={leds.data ?? []} onChange={onLedger} /></div>
      {!ledgerId ? <p className="text-body text-ink-secondary">Pick a ledger (cash, bank, party, expense …).</p> : (
        <Shell q={q} onExcel={excel} note={d && <>{d.ledger.group_name} · opening {drcr(d.opening)} · closing <b>{drcr(d.closing)}</b></>}>
          <table className="w-full" id="acc-ledger-rows">
            <thead><tr><th className="th">Date</th><th className="th">Voucher</th><th className="th">Particulars</th><th className="th">Bill ref</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th text-right">Balance</th></tr></thead>
            <tbody>
              <tr><td className="td" colSpan={6}>Opening balance</td><td className="td text-right tabular-nums">{drcr(d?.opening)}</td></tr>
              {(d?.rows ?? []).map((r: any) => (
                <tr key={r.id} className="row-hover cursor-pointer" onClick={() => nav(`/accounts/vouchers/${r.voucher_id}`)}>
                  <td className="td tabular-nums">{r.voucher_date}</td>
                  <td className="td"><p className="text-brand-700">{r.voucher_no}</p><p className="text-caption text-ink-secondary">{VOUCHER_TYPE_LABEL[r.type_code]}</p></td>
                  <td className="td"><p className="max-w-[360px] truncate">{r.against}</p><p className="max-w-[360px] truncate text-caption text-ink-secondary">{r.line_narration || r.narration}{r.io_no ? ` · IO ${r.io_no}` : ''}</p></td>
                  <td className="td">{r.bill_ref_no ?? ''}</td>
                  <td className="td text-right">{M(r.debit)}</td><td className="td text-right">{M(r.credit)}</td><td className="td text-right tabular-nums">{drcr(r.balance)}</td>
                </tr>))}
            </tbody>
            {d && <tfoot><tr className="border-t border-surface-border font-semibold"><td className="td" colSpan={4}>Total / closing</td>
              <td className="td text-right">{M(d.total_debit)}</td><td className="td text-right">{M(d.total_credit)}</td><td className="td text-right tabular-nums">{drcr(d.closing)}</td></tr></tfoot>}
          </table>
        </Shell>)}
    </div>
  );
}

// ---------------------------------------------------------------- day book
function DayBook({ from, to }: { from: string; to: string }) {
  const nav = useNavigate();
  const [type, setType] = useState('');
  const q = useReport<any>('day-book', { from, to, type: type || undefined });
  const rows = (q.data?.vouchers ?? []).flatMap((v: any) => v.entries.map((e: any, i: number) => ({ ...e, first: i === 0, v })));
  const excel = () => exportRowsToExcel(`day-book-${from}-${to}`, 'Day book',
    [{ key: 'date', header: 'Date', type: 'date' }, { key: 'no', header: 'Voucher' }, { key: 'type', header: 'Type' }, { key: 'ledger_name', header: 'Ledger' },
      { key: 'debit', header: 'Debit', type: 'money', total: true }, { key: 'credit', header: 'Credit', type: 'money', total: true }, { key: 'narration', header: 'Narration' }] as ReportColumn[],
    rows.map((r: any) => ({ date: r.v.voucher_date, no: r.v.voucher_no, type: VOUCHER_TYPE_LABEL[r.v.type_code], ledger_name: r.ledger_name, debit: Number(r.debit), credit: Number(r.credit), narration: r.first ? r.v.narration : '' })),
    `Day book ${from} to ${to}`);
  return (
    <div className="space-y-3">
      <div className="w-56"><Select value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All voucher types' }, ...Object.entries(VOUCHER_TYPE_LABEL).map(([k, l]) => ({ value: k, label: l }))]} /></div>
      <Shell q={q} onExcel={excel} note={`${q.data?.vouchers?.length ?? 0} vouchers`}>
        <table className="w-full">
          <thead><tr><th className="th">Date</th><th className="th">Voucher</th><th className="th">Ledger</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th">Narration</th></tr></thead>
          <tbody>
            {rows.map((r: any, i: number) => (
              <tr key={i} className={`row-hover cursor-pointer ${r.first ? 'border-t border-surface-border' : ''}`} onClick={() => nav(`/accounts/vouchers/${r.v.id}`)}>
                <td className="td tabular-nums">{r.first ? r.v.voucher_date : ''}</td>
                <td className="td">{r.first ? <><p className="text-brand-700">{r.v.voucher_no}</p><p className="text-caption text-ink-secondary">{VOUCHER_TYPE_LABEL[r.v.type_code]}</p></> : ''}</td>
                <td className="td">{r.ledger_name}</td><td className="td text-right">{M(r.debit)}</td><td className="td text-right">{M(r.credit)}</td>
                <td className="td max-w-[320px] truncate text-caption text-ink-secondary">{r.first ? r.v.narration : ''}</td>
              </tr>))}
          </tbody>
        </table>
      </Shell>
    </div>
  );
}

// ---------------------------------------------------------------- P&L (Tally layout)
function Heads({ heads, open, toggle, ledgerLink }: { heads: any[]; open: Set<string>; toggle: (k: string) => void; ledgerLink: (id: number) => string }) {
  return <>{heads.map((h) => (
    <tbody key={h.group_code}>
      <tr className="row-hover cursor-pointer" onClick={() => toggle(h.group_code)}><td className="td">{open.has(h.group_code) ? '▾' : '▸'} {h.group_name}</td><td className="td text-right">{M(h.amount)}</td></tr>
      {open.has(h.group_code) && h.ledgers.map((l: any) => (
        <tr key={l.id}><td className="td pl-8 text-body"><Link className="text-brand-700 hover:underline" to={ledgerLink(l.id)}>{l.ledger_name}</Link></td><td className="td text-right text-ink-secondary">{M(l.amount)}</td></tr>))}
    </tbody>))}</>;
}
function TwoSides({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="grid grid-cols-1 divide-y divide-surface-border md:grid-cols-2 md:divide-x md:divide-y-0">{left}{right}</div>;
}
function ProfitLoss({ from, to }: { from: string; to: string }) {
  const q = useReport<any>('profit-loss', { from, to });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const d = q.data;
  const link = (id: number) => `/accounts/reports?tab=ledger&ledger_id=${id}&from=${from}&to=${to}`;
  const excel = () => d && exportRowsToExcel(`profit-loss-${from}-${to}`, 'P&L', [{ key: 'side', header: 'Side' }, { key: 'head', header: 'Head' }, { key: 'ledger', header: 'Ledger' }, { key: 'amount', header: 'Amount', type: 'money' }] as ReportColumn[], [
    { side: 'Dr', head: 'Opening stock', ledger: '', amount: d.opening_stock.total },
    ...d.trading.debit.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Dr', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    ...d.trading.credit.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Cr', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    { side: 'Cr', head: 'Closing stock', ledger: '', amount: d.closing_stock.total }, { side: '', head: 'Gross profit', ledger: '', amount: d.gross_profit },
    ...d.pl.debit.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Dr', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    ...d.pl.credit.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Cr', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    { side: '', head: 'Net profit', ledger: '', amount: d.net_profit }], `Profit & loss ${from} to ${to}`);
  if (!d) return <Shell q={q}>{null}</Shell>;
  const gp = d.gross_profit;
  const np = d.net_profit;
  return (
    <Shell q={q} onExcel={excel} note={<>Stock: {d.stock_source}. Order-wise profit per IO: <Link className="text-brand-700 hover:underline" to="/reports/client-a?report=budget-vs-actuals">Budget vs Actuals</Link></>}>
      <div id="acc-pl">
        <p className="border-b border-surface-border px-4 py-2 font-semibold">Trading account</p>
        <TwoSides
          left={<table className="w-full"><thead><tr><th className="th">Particulars</th><th className="th text-right">₹</th></tr></thead>
            <tbody><tr><td className="td">Opening stock</td><td className="td text-right">{M(d.opening_stock.total)}</td></tr></tbody>
            <Heads heads={d.trading.debit} open={open} toggle={toggle} ledgerLink={link} />
            {gp > 0 && <tbody><tr className="font-semibold"><td className="td">Gross profit c/o</td><td className="td text-right">{M(gp)}</td></tr></tbody>}</table>}
          right={<table className="w-full"><thead><tr><th className="th">Particulars</th><th className="th text-right">₹</th></tr></thead>
            <Heads heads={d.trading.credit} open={open} toggle={toggle} ledgerLink={link} />
            <tbody><tr><td className="td">Closing stock</td><td className="td text-right">{M(d.closing_stock.total)}</td></tr>
              {gp < 0 && <tr className="font-semibold"><td className="td">Gross loss c/o</td><td className="td text-right">{M(-gp)}</td></tr>}</tbody></table>} />
        <p className="border-y border-surface-border px-4 py-2 font-semibold">Profit &amp; loss account</p>
        <TwoSides
          left={<table className="w-full"><tbody>{gp < 0 && <tr><td className="td">Gross loss b/f</td><td className="td text-right">{M(-gp)}</td></tr>}</tbody>
            <Heads heads={d.pl.debit} open={open} toggle={toggle} ledgerLink={link} />
            {np > 0 && <tbody><tr className="font-semibold text-status-success-text"><td className="td">Net profit</td><td className="td text-right" id="acc-pl-net">{M(np)}</td></tr></tbody>}</table>}
          right={<table className="w-full"><tbody>{gp > 0 && <tr><td className="td">Gross profit b/f</td><td className="td text-right">{M(gp)}</td></tr>}</tbody>
            <Heads heads={d.pl.credit} open={open} toggle={toggle} ledgerLink={link} />
            {np < 0 && <tbody><tr className="font-semibold text-status-error-text"><td className="td">Net loss</td><td className="td text-right" id="acc-pl-net">{M(-np)}</td></tr></tbody>}</table>} />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------- balance sheet
function BalanceSheet({ to }: { to: string }) {
  const q = useReport<any>('balance-sheet', { to });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const d = q.data;
  const link = (id: number) => `/accounts/reports?tab=ledger&ledger_id=${id}&to=${to}`;
  const excel = () => d && exportRowsToExcel(`balance-sheet-${to}`, 'Balance sheet', [{ key: 'side', header: 'Side' }, { key: 'head', header: 'Head' }, { key: 'ledger', header: 'Ledger' }, { key: 'amount', header: 'Amount', type: 'money' }] as ReportColumn[], [
    ...d.liabilities.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Liabilities', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    { side: 'Liabilities', head: 'Profit & Loss A/c', ledger: '', amount: d.profit_loss },
    ...d.assets.flatMap((h: any) => h.ledgers.map((l: any) => ({ side: 'Assets', head: h.group_name, ledger: l.ledger_name, amount: l.amount }))),
    { side: 'Assets', head: 'Closing stock', ledger: '', amount: d.closing_stock.total }], `Balance sheet as on ${to}`);
  if (!d) return <Shell q={q}>{null}</Shell>;
  return (
    <Shell q={q} onExcel={excel} note={Math.abs(d.difference) < 0.01 ? <span className="text-status-success-text">Balanced · stock: {d.stock_source}</span>
      : <span className="text-status-error-text">Difference {inr(d.difference)}{Math.abs(d.difference_in_opening) > 0.009 ? ` (opening balances differ by ${drcr(d.difference_in_opening)})` : ''}</span>}>
      <TwoSides
        left={<table className="w-full" id="acc-bs-liab"><thead><tr><th className="th">Liabilities</th><th className="th text-right">₹</th></tr></thead>
          <Heads heads={d.liabilities} open={open} toggle={toggle} ledgerLink={link} />
          <tbody><tr><td className="td">Profit &amp; Loss A/c</td><td className="td text-right">{M(d.profit_loss)}</td></tr>
            <tr className="border-t border-surface-border font-semibold"><td className="td">Total</td><td className="td text-right">{M(d.total_liabilities)}</td></tr></tbody></table>}
        right={<table className="w-full" id="acc-bs-assets"><thead><tr><th className="th">Assets</th><th className="th text-right">₹</th></tr></thead>
          <Heads heads={d.assets} open={open} toggle={toggle} ledgerLink={link} />
          <tbody><tr><td className="td">Closing stock</td><td className="td text-right">{M(d.closing_stock.total)}</td></tr>
            <tr className="border-t border-surface-border font-semibold"><td className="td">Total</td><td className="td text-right">{M(d.total_assets)}</td></tr></tbody></table>} />
    </Shell>
  );
}

// ---------------------------------------------------------------- outstanding
function Outstanding({ kind, to }: { kind: 'payables' | 'receivables'; to: string }) {
  const q = useReport<any>('outstanding', { kind, to });
  const [party, setParty] = useState<number | null>(null);
  const d = q.data;
  const buckets = ['0-30', '31-60', '61-90', '91-180', '180+'];
  const bills = (d?.bills ?? []).filter((b: any) => !party || b.ledger_id === party);
  const excel = () => d && exportRowsToExcel(`${kind}-${to}`, kind, [{ key: 'ledger_name', header: 'Party' }, { key: 'bill_ref_no', header: 'Bill' }, { key: 'kind', header: 'Kind' },
    { key: 'bill_date', header: 'Date', type: 'date' }, { key: 'due_date', header: 'Due', type: 'date' }, { key: 'age_days', header: 'Age (days)', type: 'int' }, { key: 'overdue_days', header: 'Overdue (days)', type: 'int' },
    { key: 'pending', header: 'Pending ₹', type: 'money', total: true }] as ReportColumn[], d.bills, `${kind === 'payables' ? 'Payables' : 'Receivables'} as on ${to}`);
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
      <div className="xl:col-span-2">
        <Shell q={q} note={d && <>Total <b className="tabular-nums">{inr(d.total)}</b></>} onExcel={excel}>
          <table className="w-full" id={`acc-${kind}`}>
            <thead><tr><th className="th">Party</th><th className="th text-right">Pending</th><th className="th text-right">&gt; 90 days</th></tr></thead>
            <tbody>{(d?.parties ?? []).map((p: any) => (
              <tr key={p.ledger_id} className={`row-hover cursor-pointer ${party === p.ledger_id ? 'bg-surface-hover' : ''}`} onClick={() => setParty(party === p.ledger_id ? null : p.ledger_id)}>
                <td className="td">{p.ledger_name}</td><td className="td text-right">{M(p.pending)}</td><td className="td text-right">{M((p.buckets['91-180'] ?? 0) + (p.buckets['180+'] ?? 0))}</td>
              </tr>))}</tbody>
          </table>
        </Shell>
      </div>
      <div className="xl:col-span-3">
        <Shell q={q} note={party ? 'Bills of the selected party (click the party again for all)' : 'All bills'}>
          <table className="w-full">
            <thead><tr><th className="th">Bill</th><th className="th">Date</th><th className="th">Due</th><th className="th text-right">Age</th><th className="th text-right">Pending ₹</th></tr></thead>
            <tbody>{bills.map((b: any, i: number) => (
              <tr key={i}>
                <td className="td"><p>{b.bill_ref_no ?? 'On account'}{b.kind !== 'BILL' && <span className="text-caption text-ink-secondary"> · {b.kind.toLowerCase().replace('_', ' ')}</span>}</p>{!party && <p className="text-caption text-ink-secondary">{b.ledger_name}</p>}</td>
                <td className="td tabular-nums">{b.bill_date ?? ''}</td>
                <td className={`td tabular-nums ${b.overdue_days ? 'text-status-error-text' : ''}`}>{b.due_date ?? ''}{b.overdue_days ? ` (+${b.overdue_days}d)` : ''}</td>
                <td className="td text-right tabular-nums">{b.age_days}</td><td className="td text-right">{M(b.pending)}</td>
              </tr>))}</tbody>
          </table>
          <div className="grid grid-cols-5 gap-2 border-t border-surface-border p-3 text-body">
            {buckets.map((k) => <div key={k}><p className="text-caption text-ink-secondary">{k} days</p><p className="tabular-nums">{inr(bills.filter((b: any) => b.bucket === k).reduce((t: number, b: any) => t + b.pending, 0))}</p></div>)}
          </div>
        </Shell>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- job-wise books
function JobBooks({ from, to }: { from: string; to: string }) {
  const q = useReport<any>('job-books', { from, to });
  const rows = q.data?.rows ?? [];
  const excel = () => exportRowsToExcel(`job-books-${from}-${to}`, 'Job-wise books', [{ key: 'io_no', header: 'IO' }, { key: 'so_no', header: 'Order' }, { key: 'buyer_name', header: 'Buyer' },
    { key: 'income', header: 'Sales / income', type: 'money', total: true }, { key: 'purchases', header: 'Purchases', type: 'money', total: true }, { key: 'job_work', header: 'Job work & direct exp', type: 'money', total: true },
    { key: 'margin', header: 'Margin', type: 'money', total: true }] as ReportColumn[], rows, `Job-wise books ${from} to ${to}`);
  return (
    <Shell q={q} onExcel={excel} note={<>What the books carry per IO (purchase lines get the job from their GRN / PO). The costing view per order: <Link className="text-brand-700 hover:underline" to="/reports/client-a?report=budget-vs-actuals">Budget vs Actuals</Link></>}>
      <table className="w-full" id="acc-jobs">
        <thead><tr><th className="th">IO / order</th><th className="th">Buyer</th><th className="th text-right">Sales / income</th><th className="th text-right">Purchases</th><th className="th text-right">Job work &amp; direct exp</th><th className="th text-right">Margin</th></tr></thead>
        <tbody>{rows.map((r: any, i: number) => (
          <tr key={i}>
            <td className="td">{r.so_id ? <><p>{r.io_no ?? r.so_no}</p><p className="text-caption text-ink-secondary">{r.so_no}</p></> : <span className="text-ink-secondary">No job (general)</span>}</td>
            <td className="td">{r.buyer_name ?? ''}</td><td className="td text-right">{M(r.income)}</td><td className="td text-right">{M(r.purchases)}</td><td className="td text-right">{M(r.job_work)}</td>
            <td className={`td text-right font-semibold tabular-nums ${r.margin < 0 ? 'text-status-error-text' : ''}`}>{inr(r.margin)}</td>
          </tr>))}</tbody>
      </table>
    </Shell>
  );
}
