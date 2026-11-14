/**
 * Accounts → Tally (spec §6, §9, §11 Posting Monitor).
 *   Waiting / Sent / In Tally / Problems tabs over acc_tally_queue; Tally company set-up; connection test.
 * XML file (today): select → Download XML → import in Tally (Gateway → Import → Vouchers) → Mark posted.
 * Tally server (HTTP): vouchers are sent automatically every 30 s; failures / unknown results are listed for retry.
 * Re-sending is safe: every voucher carries a REMOTEID, so Tally updates it instead of creating a duplicate.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, CheckCircle2, RotateCcw, Plug, Plus, XCircle, ListPlus } from 'lucide-react';
import { PageHeader, Button, Input, Select, Field, Tabs, Modal, LoadingBlock, Badge, Checkbox, Textarea } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { errMsg, inr, postDownload, VOUCHER_TYPE_LABEL } from './accShared';
import { TallyLedgerMatch } from './TallyLedgerMatch';

const TABS = [
  { key: 'waiting', label: 'Waiting', status: 'PENDING' }, { key: 'sent', label: 'Sent / exported', status: 'PROCESSING' },
  { key: 'problems', label: 'Problems', status: 'FAILED,UNKNOWN' }, { key: 'posted', label: 'In Tally', status: 'POSTED' }, { key: 'ledgers', label: 'Ledger matching', status: '' }, { key: 'setup', label: 'Set-up', status: '' },
];

export function TallyPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const ops = can('ACCOUNTS.TALLY') || can('ACCOUNTS.ADMIN');
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'waiting';
  const t = TABS.find((x) => x.key === tab) ?? TABS[0];
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState('');
  const [failOpen, setFailOpen] = useState(false);
  const [failReason, setFailReason] = useState('');
  const [logs, setLogs] = useState<any[] | null>(null);
  const queue = useQuery({ queryKey: ['accounts', 'tally', 'queue', t.status], enabled: !!t.status,
    queryFn: async () => (await http.get<{ data: any[] }>('/accounts/tally/queue', { status: t.status })).data });
  const rows = queue.data ?? [];
  const xmlRows = rows.filter((r) => r.connector === 'XML_FILE');
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const refresh = () => { setSel(new Set()); void qc.invalidateQueries({ queryKey: ['accounts'] }); };
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try { const m = await fn(); if (m) toast(m); refresh(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  const ids = () => [...sel];

  const cols: Column<any>[] = [
    ...(ops && tab !== 'posted' ? [{ key: 'sel', header: '', width: '36px', render: (r: any) => <input type="checkbox" aria-label="Select" checked={sel.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} /> }] : []),
    { key: 'voucher_no', header: 'Voucher', render: (r) => <div><p className="font-semibold text-brand-700">{r.voucher_no}</p><p className="text-caption text-ink-secondary">{VOUCHER_TYPE_LABEL[r.type_code]} · {r.voucher_date}</p></div> },
    { key: 'party_name', header: 'Party / document', render: (r) => <div><p>{r.party_name ?? '—'}</p><p className="text-caption text-ink-secondary">{r.source_no ?? ''}</p></div> },
    { key: 'total_debit', header: 'Amount ₹', align: 'right', render: (r) => <span className="tabular-nums">{inr(r.total_debit)}</span> },
    { key: 'tally', header: 'Tally company', render: (r) => <div><p>{r.tally_company_name}</p><p className="text-caption text-ink-secondary">{r.connector === 'HTTP' ? 'Tally server' : 'XML file'}</p></div> },
    { key: 'status', header: 'Result', render: (r) => (
      <div className="max-w-[340px]">
        {r.status === 'POSTED' ? <p className="text-status-success-text">In Tally{r.tally_voucher_no ? ` · ${r.tally_voucher_no}` : ''}</p>
          : r.last_error && r.last_error_code === 'TALLY_NOT_READY' ? <p className="text-status-info-text">Waiting for Tally: {r.last_error}</p>
          : r.last_error ? <p className="text-status-error-text">{r.status === 'UNKNOWN' ? 'Unknown: ' : ''}{r.last_error}</p> : <p className="text-ink-secondary">{r.status === 'PROCESSING' ? (r.connector === 'HTTP' ? 'Sending to Tally…' : 'Exported / sent — confirm when imported') : 'Waiting'}</p>}
        <p className="text-caption text-ink-secondary">{r.attempts} attempt(s)</p>
      </div>) },
    { key: 'act', header: '', render: (r) => (
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={async (e) => { e.stopPropagation(); setLogs((await http.get<{ data: any[] }>(`/accounts/tally/queue/${r.id}/logs`)).data); }}>Log</Button>
        {ops && r.status !== 'POSTED' && r.status !== 'PENDING' && <Button size="sm" variant="secondary" loading={busy === `retry${r.id}`}
          onClick={(e) => { e.stopPropagation(); void run(`retry${r.id}`, async () => (await http.post<{ message: string }>(`/accounts/tally/queue/${r.id}/retry`)).message); }}><RotateCcw size={14} />Retry</Button>}
      </div>) },
  ];

  return (
    <div>
      <PageHeader title="Tally" breadcrumb={['Accounts']} subtitle="Posted vouchers mirrored to TallyPrime. The ERP keeps the books; Tally receives the same vouchers (no stock items)."
        actions={ops && tab !== 'setup' && tab !== 'ledgers' && <>
          {tab === 'waiting' && <Button variant="secondary" loading={busy === 'backlog'} onClick={() => void run('backlog', async () => (await http.post<{ message: string }>('/accounts/tally/enqueue-backlog')).message)}><ListPlus size={14} />Queue older vouchers</Button>}
          {(tab === 'waiting' || tab === 'problems') && xmlRows.length > 0 && <Button variant="secondary" onClick={() => setSel(new Set(xmlRows.map((r) => r.id)))}>Select all</Button>}
          {sel.size > 0 && (tab === 'waiting' || tab === 'problems' || tab === 'sent') && (
            <Button id="acc-tally-xml" loading={busy === 'xml'} onClick={() => void run('xml', async () => { await postDownload('/accounts/tally/export', { ids: ids() }, 'tally.xml'); return `XML downloaded — import it in Tally, then Mark posted (tab "Sent")`; })}>
              <Download size={14} />Download XML ({sel.size})</Button>)}
          {sel.size > 0 && tab === 'sent' && <Button id="acc-tally-posted" loading={busy === 'posted'} onClick={() => void run('posted', async () => (await http.post<{ message: string }>('/accounts/tally/mark-posted', { items: ids().map((id) => ({ id })) })).message)}><CheckCircle2 size={14} />Mark posted</Button>}
          {sel.size > 0 && (tab === 'sent' || tab === 'waiting') && <Button variant="danger" onClick={() => setFailOpen(true)}><XCircle size={14} />Mark failed</Button>}
        </>} />
      <Tabs tabs={TABS.map((x) => ({ key: x.key, label: x.label }))} active={tab} onChange={(k) => { setSel(new Set()); setSp({ tab: k }, { replace: true }); }} />
      <div className="mt-3">
        {tab === 'ledgers' ? <TallyLedgerMatch /> : tab === 'setup' ? <TallySetup /> : (
          <DataTable columns={cols} rows={rows} loading={queue.isLoading} error={queue.error} rowKey={(r) => r.id} onRowClick={(r) => nav(`/accounts/vouchers/${r.voucher_id}`)}
            emptyTitle={tab === 'problems' ? 'No problems' : 'Nothing here'} emptyMessage={tab === 'waiting' ? 'Posted vouchers appear here when a Tally company is set up (tab Set-up).' : undefined} />)}
      </div>
      <Modal open={failOpen} onClose={() => setFailOpen(false)} title="Mark failed in Tally" size="sm"
        footer={<><Button variant="secondary" onClick={() => setFailOpen(false)}>Close</Button>
          <Button variant="danger" disabled={failReason.trim().length < 3} loading={busy === 'fail'} onClick={() => void run('fail', async () => { const r = await http.post<{ message: string }>('/accounts/tally/mark-failed', { ids: ids(), reason: failReason }); setFailOpen(false); setFailReason(''); return r.message; })}>Mark failed</Button></>}>
        <Field label="What did Tally say?" required><Textarea rows={3} value={failReason} onChange={(e) => setFailReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!logs} onClose={() => setLogs(null)} title="Tally log" size="lg">
        {(logs ?? []).length === 0 ? <p className="text-body text-ink-secondary">No attempts yet.</p> : (
          <div className="space-y-3">
            {(logs ?? []).map((l) => (
              <div key={l.id} className="rounded border border-surface-border p-2 text-body">
                <p>{String(l.created_at).slice(0, 19).replace('T', ' ')} · {l.action} · {l.outcome ?? ''}{l.http_status ? ` · HTTP ${l.http_status}` : ''}{l.duration_ms ? ` · ${l.duration_ms} ms` : ''}{l.actor ? ` · ${l.actor}` : ''}</p>
                {l.message && <p className="text-ink-secondary">{l.message}</p>}
                {l.response_payload && <details><summary className="cursor-pointer text-caption text-brand-700">Tally response</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-caption">{l.response_payload}</pre></details>}
              </div>))}
          </div>)}
      </Modal>
    </div>
  );
}

function TallySetup() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const cos = useQuery({ queryKey: ['accounts', 'tally', 'companies'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/tally/companies')).data });
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState('');
  const test = async (id: number) => {
    setBusy(`t${id}`);
    try { const r = await http.post<{ data: { ok: boolean; message: string } }>(`/accounts/tally/companies/${id}/test`); toast(r.data.message, r.data.ok ? 'success' : 'error'); void qc.invalidateQueries({ queryKey: ['accounts', 'tally'] }); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  if (cos.isLoading) return <LoadingBlock />;
  return (
    <div className="space-y-3">
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
          <p className="text-body text-ink-secondary">One active Tally company per financial year. Use the company name exactly as it shows in Tally.</p>
          {can('ACCOUNTS.ADMIN') && <Button id="acc-tally-co-new" size="sm" onClick={() => setEdit({ connector: 'XML_FILE', is_active: true, port: 9000 })}><Plus size={14} />Add Tally company</Button>}
        </div>
        <table className="w-full">
          <thead><tr><th className="th">Tally company</th><th className="th">Year</th><th className="th">Connection</th><th className="th">Last test</th><th className="th" /></tr></thead>
          <tbody>
            {(cos.data ?? []).map((c) => (
              <tr key={c.id}>
                <td className="td"><p className="font-semibold">{c.tally_company_name}</p><p className="text-caption text-ink-secondary">{c.gstin ?? ''}{!Number(c.is_active) && ' · inactive'}</p></td>
                <td className="td">{c.fy_code || 'All years'}</td>
                <td className="td">{c.connector === 'HTTP' ? `Tally server ${c.host}:${c.port ?? 9000}` : 'XML file (download & import)'}</td>
                <td className="td">{c.last_health_at ? <span className={Number(c.last_health_ok) ? 'text-status-success-text' : 'text-status-error-text'}>{c.last_health_msg}</span> : '—'}</td>
                <td className="td"><div className="flex gap-1">
                  {c.connector === 'HTTP' && <Button size="sm" variant="secondary" loading={busy === `t${c.id}`} onClick={() => void test(c.id)}><Plug size={14} />Test</Button>}
                  {can('ACCOUNTS.ADMIN') && <Button size="sm" variant="ghost" onClick={() => setEdit({ ...c, is_active: !!Number(c.is_active) })}>Edit</Button>}
                </div></td>
              </tr>))}
            {!cos.data?.length && <tr><td className="td text-ink-secondary" colSpan={5}>No Tally company yet — vouchers stay in the ERP books only.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card p-4 text-body">
        <p className="mb-1 font-semibold">Importing the XML file in TallyPrime</p>
        <ol className="list-decimal space-y-0.5 pl-5">
          <li>Open the company in Tally (the name must match the one above).</li>
          <li>Gateway of Tally → Import → Masters → choose the downloaded file (creates missing ledgers under the right groups).</li>
          <li>Import → Transactions / Vouchers → the same file.</li>
          <li>Back here: tab "Sent / exported" → select → Mark posted. A re-import of the same file does not duplicate vouchers.</li>
        </ol>
      </div>
      {edit && <TallyCompanyEditor row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TallyCompanyEditor({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<any>({ ...row, secret: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const go = async () => {
    setBusy(true); setErr('');
    const body: any = { tally_company_name: f.tally_company_name, tally_company_guid: f.tally_company_guid || null, gstin: f.gstin || null, fy_code: f.fy_code || null,
      connector: f.connector, host: f.host || null, port: f.port ? Number(f.port) : null, timeout_ms: f.timeout_ms ? Number(f.timeout_ms) : undefined, is_active: !!f.is_active };
    if (f.secret) body.secret = f.secret;
    try {
      if (row.id) await http.put(`/accounts/tally/companies/${row.id}`, body); else await http.post('/accounts/tally/companies', body);
      toast('Tally company saved'); void qc.invalidateQueries({ queryKey: ['accounts'] }); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={row.id ? 'Edit Tally company' : 'Add Tally company'} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="acc-tally-co-save" loading={busy} onClick={() => void go()}>Save</Button></>}>
      {err && <p className="mb-2 text-body text-status-error-text">{err}</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Company name in Tally" required className="md:col-span-2"><Input id="acc-tally-co-name" value={f.tally_company_name ?? ''} onChange={(e) => set('tally_company_name', e.target.value)} /></Field>
        <Field label="Financial year" hint="e.g. 2026-27 · blank = all years"><Input value={f.fy_code ?? ''} onChange={(e) => set('fy_code', e.target.value)} /></Field>
        <Field label="GSTIN"><Input value={f.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase())} /></Field>
        <Field label="Connection" className="md:col-span-2"><Select id="acc-tally-connector" value={f.connector} onChange={(e) => set('connector', e.target.value)}
          options={[{ value: 'XML_FILE', label: 'XML file — download here, import in Tally' }, { value: 'HTTP', label: 'Tally server (XML over HTTP, port 9000)' }]} /></Field>
        {f.connector === 'HTTP' && <>
          <Field label="Host / IP" required hint="Reachable from the ERP server (VPN / static IP)"><Input value={f.host ?? ''} onChange={(e) => set('host', e.target.value)} /></Field>
          <Field label="Port"><Input inputMode="numeric" value={f.port ?? ''} onChange={(e) => set('port', e.target.value)} /></Field>
          <Field label="Credential (user:password or token)" hint={row.has_secret ? 'Saved — leave blank to keep' : 'Optional'}><Input type="password" value={f.secret} onChange={(e) => set('secret', e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Timeout (ms)"><Input inputMode="numeric" value={f.timeout_ms ?? 20000} onChange={(e) => set('timeout_ms', e.target.value)} /></Field>
        </>}
        <Checkbox label="Active" checked={!!f.is_active} onChange={(v) => set('is_active', v)} />
        {row.id && <Badge tone="slate">Changing the connection does not change any voucher</Badge>}
      </div>
    </Modal>
  );
}
