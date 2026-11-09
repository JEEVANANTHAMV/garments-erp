/**
 * Accounts → Tally → Ledger matching (go-live, 09-Nov-2026).
 * Load the client's Tally ledger list (masters XML export / Excel / fetched from the Tally server), match every ERP ledger to
 * its exact Tally name (auto: same name → GSTIN → name without Ltd / Pvt / A/c), create ERP ledgers for Tally-only ones.
 * Matched ledgers are never re-created in Tally by the voucher export.
 */
import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Wand2, RefreshCw, Plus } from 'lucide-react';
import { Button, Select, Badge, LoadingBlock, ErrorState, SearchInput, Checkbox } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { errMsg, fileToBase64, inr } from './accShared';

export function TallyLedgerMatch() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const admin = can('ACCOUNTS.ADMIN');
  const cos = useQuery({ queryKey: ['accounts', 'tally', 'companies'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/tally/companies')).data });
  const [tcId, setTcId] = useState<string>('');
  const tc = (cos.data ?? []).find((c) => String(c.id) === tcId) ?? (cos.data ?? []).find((c) => Number(c.is_active)) ?? (cos.data ?? [])[0];
  const data = useQuery({ queryKey: ['accounts', 'tally', 'ledgers', tc?.id], enabled: !!tc,
    queryFn: async () => (await http.get<{ data: any }>(`/accounts/tally/companies/${tc.id}/ledgers`)).data });
  const groups = useQuery({ queryKey: ['accounts', 'groups'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/groups')).data });
  const [busy, setBusy] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});   // tally-only name → ERP group id
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['accounts'] });
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try { toast(await fn()); refresh(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  const tallyNames = useMemo(() => (data.data?.erp ? [...(data.data.tally_only ?? []).map((t: any) => t.tally_name)] : []), [data.data]);
  const groupByName = useMemo(() => new Map((groups.data ?? []).map((g) => [String(g.group_name).toLowerCase(), g])), [groups.data]);

  if (cos.isLoading) return <LoadingBlock />;
  if (!cos.data?.length) return <p className="card p-4 text-body text-ink-secondary">Add the Tally company first (tab Set-up).</p>;
  const d = data.data;
  const q = search.trim().toLowerCase();
  const erp = (d?.erp ?? []).filter((l: any) => (!onlyOpen || l.status !== 'MATCHED') && (!q || `${l.ledger_name} ${l.tally_name ?? ''}`.toLowerCase().includes(q)));
  const tOnly = (d?.tally_only ?? []).filter((t: any) => !q || String(t.tally_name).toLowerCase().includes(q));
  const matched = (d?.erp ?? []).filter((l: any) => l.status === 'MATCHED').length;

  const upload = async (f: File) => run('file', async () => (await http.post<{ message: string }>(`/accounts/tally/companies/${tc.id}/ledgers/import`,
    { filename: f.name, content_base64: await fileToBase64(f) })).message);
  const setName = (id: number, name: string | null) => run(`m${id}`, async () => (await http.put<{ message: string }>(`/accounts/tally/ledger-map/${id}`, { tally_name: name })).message);
  const createSel = () => run('create', async () => (await http.post<{ message: string }>(`/accounts/tally/companies/${tc.id}/ledgers/create-in-erp`,
    { items: Object.entries(pick).filter(([, g]) => g).map(([tally_name, group_id]) => ({ tally_name, group_id: Number(group_id) })) })).message);

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <div className="w-72"><Select value={String(tc?.id ?? '')} onChange={(e) => setTcId(e.target.value)}
          options={(cos.data ?? []).map((c) => ({ value: String(c.id), label: `${c.tally_company_name}${Number(c.is_active) ? '' : ' (inactive)'}` }))} /></div>
        {admin && <>
          <input ref={fileRef} type="file" accept=".xml,.txt,.xlsx,.xls,.csv" className="hidden" id="acc-tl-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          <Button id="acc-tl-upload" variant="secondary" loading={busy === 'file'} onClick={() => fileRef.current?.click()}><Upload size={14} />Load Tally ledger list</Button>
          {tc?.connector === 'HTTP' && <Button variant="secondary" loading={busy === 'fetch'} onClick={() => void run('fetch', async () => (await http.post<{ message: string }>(`/accounts/tally/companies/${tc.id}/ledgers/fetch`)).message)}><RefreshCw size={14} />Fetch from Tally</Button>}
          <Button id="acc-tl-auto" disabled={!d?.loaded} loading={busy === 'auto'} onClick={() => void run('auto', async () => (await http.post<{ message: string }>(`/accounts/tally/companies/${tc.id}/ledgers/auto-match`)).message)}><Wand2 size={14} />Auto-match</Button>
        </>}
        <div className="ml-auto text-body text-ink-secondary">
          {d ? <>{d.loaded ? `${d.loaded} Tally ledgers loaded ${String(d.loaded_at ?? '').slice(0, 10)}` : 'Tally ledger list not loaded'} · <b className="text-ink">{matched}</b> of {d.erp.length} ERP ledgers matched</> : ''}
        </div>
      </div>
      <p className="text-caption text-ink-secondary">In Tally: Gateway → Export → Masters (Ledgers, XML) — or Display → List of Accounts exported to Excel. Upload the file here.</p>
      <div className="flex items-center gap-3">
        <div className="w-80"><SearchInput value={search} onChange={setSearch} placeholder="Ledger name" /></div>
        <Checkbox label="Only ledgers not matched yet" checked={onlyOpen} onChange={setOnlyOpen} />
      </div>
      {data.isLoading ? <LoadingBlock /> : data.error ? <ErrorState error={data.error} /> : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
          <div className="card overflow-x-auto xl:col-span-3">
            <p className="border-b border-surface-border px-4 py-2 font-semibold">ERP ledgers → Tally name</p>
            <table className="w-full" id="acc-tl-erp">
              <thead><tr><th className="th">ERP ledger</th><th className="th">Status</th><th className="th min-w-[260px]">Tally ledger</th></tr></thead>
              <tbody>{erp.map((l: any) => (
                <tr key={l.id}>
                  <td className="td"><p>{l.ledger_name}</p><p className="text-caption text-ink-secondary">{l.group_name}{Number(l.used) ? ` · ${l.used} entries` : ''}</p></td>
                  <td className="td">{l.status === 'MATCHED' ? <Badge tone="green">In Tally</Badge> : d.loaded ? <Badge tone="amber">New in Tally</Badge> : <Badge tone="slate">Not checked</Badge>}
                    {l.suggestion && <p className="mt-1 text-caption">Suggest: <button type="button" className="text-brand-700 hover:underline" onClick={() => void setName(l.id, l.suggestion)}>{l.suggestion}</button></p>}</td>
                  <td className="td">{admin ? (
                    <select className="input w-full" value={l.status === 'MATCHED' ? l.effective_name : ''} disabled={busy === `m${l.id}`}
                      onChange={(e) => void setName(l.id, e.target.value || null)}>
                      <option value="">{l.status === 'MATCHED' ? '(clear — use the ERP name)' : `— create in Tally as "${l.effective_name}" —`}</option>
                      {l.status === 'MATCHED' && <option value={l.effective_name}>{l.effective_name}</option>}
                      {tallyNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>) : (l.status === 'MATCHED' ? l.effective_name : '—')}</td>
                </tr>))}
                {!erp.length && <tr><td className="td text-ink-secondary" colSpan={3}>{onlyOpen ? 'Every ERP ledger is matched.' : 'No ledgers.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card overflow-x-auto xl:col-span-2">
            <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
              <p className="font-semibold">Only in Tally ({tOnly.length})</p>
              {admin && Object.values(pick).some(Boolean) && <Button size="sm" loading={busy === 'create'} onClick={() => void createSel()}><Plus size={14} />Create in ERP</Button>}
            </div>
            <table className="w-full" id="acc-tl-only">
              <thead><tr><th className="th">Tally ledger</th><th className="th text-right">Opening</th><th className="th min-w-[180px]">Create in ERP group</th></tr></thead>
              <tbody>{tOnly.map((t: any) => {
                const guess = groupByName.get(String(t.parent_name ?? '').toLowerCase());
                return (
                  <tr key={t.id}>
                    <td className="td"><p>{t.tally_name}</p><p className="text-caption text-ink-secondary">{t.parent_name ?? ''}{t.gstin ? ` · ${t.gstin}` : ''}{Number(t.bills) ? ` · ${t.bills} bills` : ''}</p></td>
                    <td className="td text-right tabular-nums">{t.opening_balance != null && Number(t.opening_balance) ? `${inr(Math.abs(t.opening_balance))} ${Number(t.opening_balance) > 0 ? 'Dr' : 'Cr'}` : ''}</td>
                    <td className="td">{admin && (
                      <select className="input w-full" value={pick[t.tally_name] ?? ''} onChange={(e) => setPick((p) => ({ ...p, [t.tally_name]: e.target.value }))}>
                        <option value="">{guess ? `— (${guess.group_name}?) —` : '—'}</option>
                        {(groups.data ?? []).filter((g) => Number(g.is_active)).map((g) => <option key={g.id} value={g.id}>{g.group_name}</option>)}
                      </select>)}
                      {admin && guess && !pick[t.tally_name] && <button type="button" className="text-caption text-brand-700 hover:underline" onClick={() => setPick((p) => ({ ...p, [t.tally_name]: String(guess.id) }))}>use {guess.group_name}</button>}
                    </td>
                  </tr>);
              })}
                {!tOnly.length && <tr><td className="td text-ink-secondary" colSpan={3}>{d?.loaded ? 'Every Tally ledger has an ERP ledger.' : 'Load the Tally ledger list.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>)}
    </div>
  );
}
