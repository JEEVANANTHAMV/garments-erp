/**
 * Accounts → Ledgers & groups, and Settings.
 *   /accounts/ledgers     ledgers (balance, posting roles, Tally name) + group tree (Tally's 28 groups + own sub-groups)
 *   /accounts/settings    posting ledgers (role → ledger) · automatic posting switches · voucher types · period lock
 * Masters are never deleted once used — deactivate instead (spec §7.1). Changes are audited.
 */
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { PageHeader, Button, Input, Select, Field, Tabs, Modal, LoadingBlock, ErrorState, Badge, SearchInput, Checkbox, Textarea } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { errMsg, drcr, useLedgerOptions, LedgerSelect, VOUCHER_TYPE_LABEL } from './accShared';

// ================================================================ ledgers & groups
export function AccountsLedgersPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'ledgers';
  return (
    <div>
      <PageHeader title="Ledgers & groups" breadcrumb={['Accounts']} subtitle="Chart of accounts. Groups follow Tally; party ledgers are created automatically on first posting (or all at once)." />
      <Tabs tabs={[{ key: 'ledgers', label: 'Ledgers' }, { key: 'groups', label: 'Groups' }]} active={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
      <div className="mt-3">{tab === 'groups' ? <GroupsTab /> : <LedgersTab />}</div>
    </div>
  );
}

function useGroups() {
  return useQuery({ queryKey: ['accounts', 'groups'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/groups')).data });
}
/** Groups in tree order with depth. */
function treeOrder(groups: any[]) {
  const kids = new Map<number | null, any[]>();
  for (const g of groups) { const p = g.parent_id ? Number(g.parent_id) : null; kids.set(p, [...(kids.get(p) ?? []), g]); }
  const out: { g: any; depth: number }[] = [];
  const walk = (p: number | null, d: number) => { for (const g of kids.get(p) ?? []) { out.push({ g, depth: d }); walk(Number(g.id), d + 1); } };
  walk(null, 0);
  return out;
}

function LedgersTab() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const admin = can('ACCOUNTS.ADMIN');
  const groups = useGroups();
  const [search, setSearch] = useState('');
  const [grp, setGrp] = useState('');
  const [type, setType] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const params = { q: search || undefined, group_id: grp || undefined, type: type || undefined };
  const list = useQuery({ queryKey: ['accounts', 'ledgers', params], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/ledgers', params)).data });
  const syncParties = async () => {
    setBusy(true);
    try { const r = await http.post<{ message: string }>('/accounts/ledgers/sync-parties'); toast(r.message); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const tree = treeOrder(groups.data ?? []);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-72"><SearchInput value={search} onChange={setSearch} placeholder="Ledger name / code" /></div>
        <div className="w-64"><Select value={grp} onChange={(e) => setGrp(e.target.value)} options={[{ value: '', label: 'All groups' }, ...tree.map(({ g, depth }) => ({ value: String(g.id), label: `${'· '.repeat(depth)}${g.group_name}` }))]} /></div>
        <div className="w-44"><Select value={type} onChange={(e) => setType(e.target.value)} options={[{ value: '', label: 'All types' }, ...['GENERAL', 'PARTY', 'BANK', 'CASH', 'TAX', 'STOCK'].map((t) => ({ value: t, label: t[0] + t.slice(1).toLowerCase() }))]} /></div>
        <div className="ml-auto flex gap-2">
          {admin && <Button variant="secondary" loading={busy} onClick={() => void syncParties()}><Users size={14} />Create party ledgers</Button>}
          {admin && <Button id="acc-ledger-new" onClick={() => setEdit({ opening_dr_cr: 'DR', is_active: true })}><Plus size={14} />New ledger</Button>}
        </div>
      </div>
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : (
          <table className="w-full" id="acc-ledgers">
            <thead><tr><th className="th">Ledger</th><th className="th">Group</th><th className="th">Type</th><th className="th">Used for</th><th className="th text-right">Balance</th><th className="th">Tally name</th><th className="th" /></tr></thead>
            <tbody>
              {(list.data ?? []).map((l) => (
                <tr key={l.id} className="row-hover">
                  <td className="td"><p className="font-semibold">{l.ledger_name}</p><p className="text-caption text-ink-secondary">{l.ledger_code}{Number(l.is_bill_wise) ? ' · bill-wise' : ''}{l.gstin ? ` · ${l.gstin}` : ''}</p></td>
                  <td className="td">{l.group_name}</td>
                  <td className="td">{l.ledger_type}{!Number(l.is_active) && <Badge tone="slate" className="ml-1">Inactive</Badge>}</td>
                  <td className="td text-caption text-ink-secondary">{l.roles ? l.roles.split(',').map((r: string) => r.toLowerCase().replace(/_/g, ' ')).join(', ') : ''}</td>
                  <td className="td text-right tabular-nums">
                    <button type="button" className="text-brand-700 hover:underline" onClick={() => nav(`/accounts/reports?tab=ledger&ledger_id=${l.id}`)}>{drcr(l.balance)}</button>
                  </td>
                  <td className="td">{l.tally_name ?? <span className="text-caption text-ink-secondary">same</span>}</td>
                  <td className="td">{admin && <button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setEdit({ ...l, is_active: !!Number(l.is_active), is_bill_wise: !!Number(l.is_bill_wise), is_cost_centre_on: !!Number(l.is_cost_centre_on) })}>Edit</button>}</td>
                </tr>))}
            </tbody>
          </table>)}
      </div>
      {edit && <LedgerEditor row={edit} groups={tree} onClose={() => setEdit(null)} />}
    </div>
  );
}

function LedgerEditor({ row, groups, onClose }: { row: any; groups: { g: any; depth: number }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const banks = useLookup('company-bank-accounts');
  const [f, setF] = useState<any>({ ...row, opening_balance: row.opening_balance != null ? String(Number(row.opening_balance)) : '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const go = async () => {
    setBusy(true); setErr('');
    const body = { ledger_name: f.ledger_name, ledger_code: f.ledger_code || null, group_id: Number(f.group_id) || undefined, ledger_type: f.ledger_type || undefined,
      bank_account_id: f.bank_account_id ? Number(f.bank_account_id) : null, is_bill_wise: !!f.is_bill_wise, is_cost_centre_on: !!f.is_cost_centre_on,
      tax_kind: f.tax_kind || null, tax_direction: f.tax_direction || null, gstin: f.gstin || null, opening_balance: Number(f.opening_balance) || 0,
      opening_dr_cr: f.opening_dr_cr || 'DR', opening_date: f.opening_date || null, tally_name: f.tally_name || null, remarks: f.remarks || null, is_active: !!f.is_active };
    try {
      if (row.id) await http.put(`/accounts/ledgers/${row.id}`, body); else await http.post('/accounts/ledgers', body);
      toast('Ledger saved'); void qc.invalidateQueries({ queryKey: ['accounts'] }); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={row.id ? `Ledger — ${row.ledger_name}` : 'New ledger'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="acc-ledger-save" loading={busy} onClick={() => void go()}>Save</Button></>}>
      {err && <p className="mb-2 text-body text-status-error-text">{err}</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Ledger name" required className="md:col-span-2"><Input id="acc-ledger-name" value={f.ledger_name ?? ''} onChange={(e) => set('ledger_name', e.target.value)} /></Field>
        <Field label="Code" hint="Blank = from the name"><Input value={f.ledger_code ?? ''} onChange={(e) => set('ledger_code', e.target.value)} /></Field>
        <Field label="Group" required className="md:col-span-2">
          <Select id="acc-ledger-group" value={String(f.group_id ?? '')} onChange={(e) => set('group_id', e.target.value)}
            options={groups.filter(({ g }) => Number(g.is_active)).map(({ g, depth }) => ({ value: String(g.id), label: `${'· '.repeat(depth)}${g.group_name}` }))} placeholder="Pick the group" />
        </Field>
        <Field label="Type"><Select value={f.ledger_type ?? 'GENERAL'} disabled={!!Number(row.is_system)} onChange={(e) => set('ledger_type', e.target.value)}
          options={['GENERAL', 'PARTY', 'BANK', 'CASH', 'TAX', 'STOCK'].map((t) => ({ value: t, label: t[0] + t.slice(1).toLowerCase() }))} /></Field>
        {f.ledger_type === 'BANK' && <Field label="Our bank account" className="md:col-span-2"><Select value={String(f.bank_account_id ?? '')} onChange={(e) => set('bank_account_id', e.target.value)} options={toOptions(banks.data)} placeholder="Link to bank account" /></Field>}
        {f.ledger_type === 'TAX' && <>
          <Field label="Tax"><Select value={f.tax_kind ?? ''} onChange={(e) => set('tax_kind', e.target.value)} options={['', 'CGST', 'SGST', 'IGST', 'CESS', 'TDS', 'TCS'].map((t) => ({ value: t, label: t || '—' }))} /></Field>
          <Field label="Direction"><Select value={f.tax_direction ?? ''} onChange={(e) => set('tax_direction', e.target.value)} options={[{ value: '', label: '—' }, { value: 'IN', label: 'Input (credit)' }, { value: 'OUT', label: 'Output (payable)' }]} /></Field>
        </>}
        <Field label="GSTIN"><Input value={f.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())} /></Field>
        <Field label="Opening balance ₹"><Input inputMode="decimal" className="tabular-nums" value={f.opening_balance} onChange={(e) => set('opening_balance', e.target.value)} /></Field>
        <Field label="Dr / Cr"><Select value={f.opening_dr_cr ?? 'DR'} onChange={(e) => set('opening_dr_cr', e.target.value)} options={[{ value: 'DR', label: 'Dr' }, { value: 'CR', label: 'Cr' }]} /></Field>
        <Field label="Opening as on"><Input type="date" value={f.opening_date ?? ''} onChange={(e) => set('opening_date', e.target.value)} /></Field>
        <Field label="Name in Tally" hint="Blank = same name" className="md:col-span-2"><Input value={f.tally_name ?? ''} onChange={(e) => set('tally_name', e.target.value)} /></Field>
        <div className="flex flex-col justify-end gap-1">
          <Checkbox label="Bill-wise" checked={!!f.is_bill_wise} onChange={(v) => set('is_bill_wise', v)} />
          <Checkbox label="Job / cost centre on lines" checked={!!f.is_cost_centre_on} onChange={(v) => set('is_cost_centre_on', v)} />
          <Checkbox label="Active" checked={!!f.is_active} onChange={(v) => set('is_active', v)} />
        </div>
        <Field label="Remarks" className="md:col-span-3"><Textarea rows={2} value={f.remarks ?? ''} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function GroupsTab() {
  const { can } = useAuth();
  const groups = useGroups();
  const [edit, setEdit] = useState<any>(null);
  if (groups.isLoading) return <LoadingBlock />;
  if (groups.error) return <ErrorState error={groups.error} />;
  const tree = treeOrder(groups.data ?? []);
  return (
    <div className="card overflow-x-auto">
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
        <p className="text-body text-ink-secondary">Tally's predefined groups cannot be renamed or moved; add your own sub-groups under them.</p>
        {can('ACCOUNTS.ADMIN') && <Button id="acc-group-new" size="sm" onClick={() => setEdit({})}><Plus size={14} />New sub-group</Button>}
      </div>
      <table className="w-full" id="acc-groups">
        <thead><tr><th className="th">Group</th><th className="th">Nature</th><th className="th">Gross profit</th><th className="th text-right">Ledgers</th><th className="th">Tally name</th><th className="th" /></tr></thead>
        <tbody>
          {tree.map(({ g, depth }) => (
            <tr key={g.id} className="row-hover">
              <td className="td" style={{ paddingLeft: `${12 + depth * 20}px` }}><span className={depth ? '' : 'font-semibold'}>{g.group_name}</span>{Number(g.is_system) ? <Badge tone="slate" className="ml-2">Tally</Badge> : null}{!Number(g.is_active) && <Badge tone="slate" className="ml-1">Inactive</Badge>}</td>
              <td className="td">{g.nature[0] + g.nature.slice(1).toLowerCase()}</td>
              <td className="td">{Number(g.affects_gross_profit) ? 'Yes' : ''}</td>
              <td className="td text-right tabular-nums">{g.ledgers}</td>
              <td className="td">{g.tally_name ?? <span className="text-caption text-ink-secondary">same</span>}</td>
              <td className="td">{can('ACCOUNTS.ADMIN') && <button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setEdit(g)}>Edit</button>}</td>
            </tr>))}
        </tbody>
      </table>
      {edit && <GroupEditor row={edit} tree={tree} onClose={() => setEdit(null)} />}
    </div>
  );
}

function GroupEditor({ row, tree, onClose }: { row: any; tree: { g: any; depth: number }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const sys = !!Number(row.is_system);
  const [f, setF] = useState({ group_name: row.group_name ?? '', parent_id: String(row.parent_id ?? ''), tally_name: row.tally_name ?? '', is_active: row.id ? !!Number(row.is_active) : true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...f, parent_id: Number(f.parent_id) || undefined, tally_name: f.tally_name || null };
      if (row.id) await http.put(`/accounts/groups/${row.id}`, body); else await http.post('/accounts/groups', body);
      toast('Group saved'); void qc.invalidateQueries({ queryKey: ['accounts'] }); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={row.id ? `Group — ${row.group_name}` : 'New sub-group'} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="acc-group-save" loading={busy} onClick={() => void go()}>Save</Button></>}>
      {err && <p className="mb-2 text-body text-status-error-text">{err}</p>}
      <div className="space-y-3">
        <Field label="Group name" required><Input id="acc-group-name" disabled={sys} value={f.group_name} onChange={(e) => setF({ ...f, group_name: e.target.value })} /></Field>
        <Field label="Under" required><Select id="acc-group-parent" disabled={sys} value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}
          options={tree.filter(({ g }) => g.id !== row.id).map(({ g, depth }) => ({ value: String(g.id), label: `${'· '.repeat(depth)}${g.group_name}` }))} placeholder="Parent group" /></Field>
        <Field label="Name in Tally" hint="Blank = same name"><Input value={f.tally_name} onChange={(e) => setF({ ...f, tally_name: e.target.value })} /></Field>
        {!sys && <Checkbox label="Active" checked={f.is_active} onChange={(v) => setF({ ...f, is_active: v })} />}
      </div>
    </Modal>
  );
}

// ================================================================ settings
export function AccountsSettingsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'roles';
  return (
    <div>
      <PageHeader title="Accounts settings" breadcrumb={['Accounts']} subtitle="Which ledgers automatic vouchers use, which documents post automatically, voucher numbering and the period lock." />
      <Tabs tabs={[{ key: 'roles', label: 'Posting ledgers' }, { key: 'rules', label: 'Automatic posting' }, { key: 'types', label: 'Voucher types' }, { key: 'lock', label: 'Period lock' }, { key: 'options', label: 'Books options' }]}
        active={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
      <div className="mt-3">
        {tab === 'roles' && <RolesTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'types' && <TypesTab />}
        {tab === 'lock' && <LockTab />}
        {tab === 'options' && <OptionsTab />}
      </div>
    </div>
  );
}

function RolesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const ledgers = useLedgerOptions();
  const roles = useQuery({ queryKey: ['accounts', 'ledger-roles'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/ledger-roles')).data });
  const save = async (role_code: string, ledger_id: number | null) => {
    try { await http.put('/accounts/ledger-roles', { role_code, ledger_id }); toast('Posting ledger saved'); void qc.invalidateQueries({ queryKey: ['accounts', 'ledger-roles'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  if (roles.isLoading) return <LoadingBlock />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" id="acc-roles">
        <thead><tr><th className="th">Posting role</th><th className="th">Used by</th><th className="th min-w-[340px]">Ledger</th></tr></thead>
        <tbody>
          {(roles.data ?? []).map((r) => (
            <tr key={r.code}>
              <td className="td"><p className="font-semibold">{r.label}</p><p className="text-caption text-ink-secondary">{r.code}</p></td>
              <td className="td text-body text-ink-secondary">{r.used}</td>
              <td className="td">{can('ACCOUNTS.ADMIN')
                ? <LedgerSelect id={`acc-role-${r.code}`} value={r.ledger_id} options={ledgers.data ?? []} placeholder="Not mapped — automatic vouchers stop" onChange={(x) => void save(r.code, x)} />
                : (r.ledger_name ?? <span className="text-status-error-text">Not mapped</span>)}</td>
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function RulesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const rules = useQuery({ queryKey: ['accounts', 'rules'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/rules')).data });
  const save = async (code: string, mode: string, effective_from: string | null) => {
    try { await http.put(`/accounts/rules/${encodeURIComponent(code)}`, { mode, effective_from }); toast('Saved'); void qc.invalidateQueries({ queryKey: ['accounts', 'rules'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  if (rules.isLoading) return <LoadingBlock />;
  return (
    <div className="card overflow-x-auto">
      <p className="border-b border-surface-border px-4 py-2 text-body text-ink-secondary">
        <b>Review</b>: the voucher is made and waits for an accounts approver. <b>Auto</b>: posted at once. <b>Off</b>: not made by the scan (the inbox can still make one).
        Documents dated before the start date are left out.
      </p>
      <table className="w-full" id="acc-rules">
        <thead><tr><th className="th">Document</th><th className="th">Voucher</th><th className="th w-44">Posting</th><th className="th w-48">From date</th></tr></thead>
        <tbody>
          {(rules.data ?? []).map((r) => (
            <tr key={r.code}>
              <td className="td">{r.label}</td>
              <td className="td">{VOUCHER_TYPE_LABEL[r.voucher] ?? r.voucher}</td>
              <td className="td"><Select id={`acc-rule-${r.code}`} disabled={!can('ACCOUNTS.ADMIN')} value={r.mode} onChange={(e) => void save(r.code, e.target.value, r.effective_from)}
                options={[{ value: 'REVIEW', label: 'Review' }, { value: 'AUTO', label: 'Auto' }, { value: 'OFF', label: 'Off' }]} /></td>
              <td className="td"><Input type="date" disabled={!can('ACCOUNTS.ADMIN')} value={r.effective_from ?? ''} onChange={(e) => void save(r.code, r.mode, e.target.value || null)} /></td>
            </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function TypesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const types = useQuery({ queryKey: ['accounts', 'voucher-types'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/voucher-types')).data });
  const [edit, setEdit] = useState<Record<string, any>>({});
  const save = async (t: any) => {
    try { await http.put(`/accounts/voucher-types/${t.type_code}`, { ...edit[t.type_code] }); toast('Saved'); setEdit((x) => { const n = { ...x }; delete n[t.type_code]; return n; }); void qc.invalidateQueries({ queryKey: ['accounts', 'voucher-types'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  if (types.isLoading) return <LoadingBlock />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead><tr><th className="th">Type</th><th className="th">Number prefix</th><th className="th">Tally voucher type</th><th className="th">Maker-checker</th><th className="th" /></tr></thead>
        <tbody>
          {(types.data ?? []).map((t) => {
            const e = edit[t.type_code] ?? {};
            const val = (k: string) => (k in e ? e[k] : t[k]);
            const put = (k: string, v: unknown) => setEdit((x) => ({ ...x, [t.type_code]: { ...e, [k]: v } }));
            return (
              <tr key={t.type_code}>
                <td className="td">{t.type_name}</td>
                <td className="td"><Input disabled={!can('ACCOUNTS.ADMIN')} value={val('prefix')} onChange={(ev) => put('prefix', ev.target.value)} /><p className="text-caption text-ink-secondary">e.g. {val('prefix')}/2026-27/00001</p></td>
                <td className="td"><Input disabled={!can('ACCOUNTS.ADMIN')} value={val('tally_voucher_type')} onChange={(ev) => put('tally_voucher_type', ev.target.value)} /></td>
                <td className="td"><Checkbox label="Another user approves" checked={!!Number(val('approval_required'))} onChange={(v) => put('approval_required', v)} /></td>
                <td className="td">{edit[t.type_code] && <Button size="sm" onClick={() => void save(t)}>Save</Button>}</td>
              </tr>);
          })}
        </tbody>
      </table>
    </div>
  );
}

function LockTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const lock = useQuery({ queryKey: ['accounts', 'period-lock'], queryFn: async () => (await http.get<{ data: any }>('/accounts/period-lock')).data });
  const [d, setD] = useState<string | null>(null);
  const val = useMemo(() => d ?? lock.data?.locked_upto ?? '', [d, lock.data]);
  const save = async (locked_upto: string | null) => {
    try { const r = await http.put<{ message: string }>('/accounts/period-lock', { locked_upto }); toast(r.message); setD(null); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <div className="card max-w-xl space-y-3 p-4">
      <p className="text-body">No voucher dated on or before this date can be posted, reversed or cancelled. Unposted vouchers in the period must be posted or cancelled first.</p>
      <Field label="Books locked up to"><Input id="acc-lock-date" type="date" disabled={!can('ACCOUNTS.ADMIN')} value={val} onChange={(e) => setD(e.target.value)} /></Field>
      {can('ACCOUNTS.ADMIN') && <div className="flex gap-2">
        <Button id="acc-lock-save" onClick={() => void save(val || null)}>Save lock</Button>
        {lock.data?.locked_upto && <Button variant="secondary" onClick={() => void save(null)}>Unlock</Button>}
      </div>}
    </div>
  );
}

function OptionsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const o = useQuery({ queryKey: ['accounts', 'options'], queryFn: async () => (await http.get<{ data: { stock_from_erp: boolean; scan_minutes: number } }>('/accounts/options')).data });
  const [mins, setMins] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>) => {
    try { const r = await http.put<{ message: string }>('/accounts/options', body); toast(r.message); setMins(null); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  if (o.isLoading || !o.data) return <LoadingBlock />;
  const admin = can('ACCOUNTS.ADMIN');
  return (
    <div className="card max-w-2xl space-y-4 p-4">
      <div>
        <Checkbox label="Include stock in P&L and balance sheet from the ERP stock valuation" checked={o.data.stock_from_erp} disabled={!admin}
          onChange={(v) => void save({ stock_from_erp: v })} />
        <p className="mt-1 text-caption text-ink-secondary">
          Opening and closing stock = ERP stock ledger (qty × rate) on the dates. Turn on only after Finance approves the inventory policy and every GRN of the
          period has its bill in the books — otherwise goods received but not billed raise the profit. Off: only the Opening Stock ledger is used.
        </p>
      </div>
      <Field label="Scan ERP documents every (minutes)" hint="0 = only when someone clicks Scan now">
        <div className="flex gap-2">
          <Input id="acc-opt-mins" inputMode="numeric" disabled={!admin} value={mins ?? String(o.data.scan_minutes)} onChange={(e) => setMins(e.target.value)} />
          {admin && mins !== null && <Button onClick={() => void save({ scan_minutes: Number(mins) || 0 })}>Save</Button>}
        </div>
      </Field>
    </div>
  );
}
