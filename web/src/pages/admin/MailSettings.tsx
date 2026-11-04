import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Send, Mail, ShieldCheck } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';
import { FormSection, Input, Select, Checkbox, Spinner, LoadingBlock, Field, Badge } from '../../components/ui';

/**
 * Admin → Settings → Mail (SMTP): the company's own outgoing mail server, used to e-mail purchase orders (PDF attached)
 * to suppliers. The password is stored encrypted on the server and is never shown again — only "saved".
 */
interface MailSettings {
  smtp_host: string; smtp_port: number; smtp_secure: boolean; smtp_username: string; has_password: boolean;
  from_name: string; from_email: string; reply_to: string; default_cc: string;
  po_subject_tpl: string; po_body_tpl: string; is_active: boolean; configured: boolean; updated_at: string | null;
}

const PRESETS: Record<string, { host: string; port: number; secure: boolean; note: string }> = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false, note: 'Gmail / Google Workspace: turn on 2-step verification and use an App password (not the normal password).' },
  office365: { host: 'smtp.office365.com', port: 587, secure: false, note: 'Microsoft 365: the mailbox needs "Authenticated SMTP" (SMTP AUTH) enabled by your admin.' },
  zoho: { host: 'smtp.zoho.in', port: 465, secure: true, note: 'Zoho Mail (India): use an app-specific password when 2FA is on.' },
  rediff: { host: 'smtp.rediffmailpro.com', port: 465, secure: true, note: 'Rediffmail Pro business mail.' },
};

export function MailSettingsPanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const editable = can('SETTINGS.UPDATE') || can('COMPANY.UPDATE');
  const q = useQuery({
    queryKey: ['settings/mail'],
    queryFn: async () => (await http.get<{ data: MailSettings }>('/settings/mail')).data,
  });
  const [f, setF] = useState<MailSettings | null>(null);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [preset, setPreset] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  useEffect(() => { if (!testTo && (user as any)?.email) setTestTo(String((user as any).email)); }, [user, testTo]);

  if (q.isLoading || !f) return <div className="card"><LoadingBlock rows={6} /></div>;
  const set = <K extends keyof MailSettings>(k: K, v: MailSettings[K]) => setF((cur) => (cur ? { ...cur, [k]: v } : cur));

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await http.put<{ data: MailSettings }>('/settings/mail', {
        smtp_host: f.smtp_host, smtp_port: Number(f.smtp_port) || 587, smtp_secure: f.smtp_secure, smtp_username: f.smtp_username,
        ...(password ? { smtp_password: password } : {}), ...(clearPassword ? { clear_password: true } : {}),
        from_name: f.from_name, from_email: f.from_email, reply_to: f.reply_to, default_cc: f.default_cc,
        po_subject_tpl: f.po_subject_tpl, po_body_tpl: f.po_body_tpl, is_active: f.is_active,
      });
      setF(r.data); setPassword(''); setClearPassword(false);
      void qc.invalidateQueries({ queryKey: ['settings/mail'] });
      toast(r.data.configured ? 'Mail settings saved — send a test mail to check them' : 'Mail settings saved');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const test = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await http.post<{ data: { to: string } }>('/settings/mail/test', { to: testTo });
      setTestResult({ ok: true, msg: `Test mail sent to ${r.data.to}. Check that inbox (and spam).` });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof ApiError ? e.message : String(e) });
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-4" id="mail-settings">
      <div className="card p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Mail size={18} className="text-brand-600" />
          <h2 className="text-title font-semibold text-ink">Outgoing mail (SMTP)</h2>
          {f.configured
            ? <Badge tone="green">Set up</Badge>
            : <Badge tone="amber">Not set up</Badge>}
          <p className="w-full text-small text-ink-secondary">
            Purchase orders are e-mailed to suppliers from this mail account, with the PO PDF attached. Each company has its own settings.
          </p>
        </div>

        <FormSection title="Mail server" cols={3}>
          <Select label="Provider (fills host / port)" value={preset} onChange={(e) => {
            const k = e.target.value; setPreset(k);
            const p = PRESETS[k]; if (p) setF((cur) => (cur ? { ...cur, smtp_host: p.host, smtp_port: p.port, smtp_secure: p.secure } : cur));
          }} placeholder="Other / custom"
            options={[{ value: 'gmail', label: 'Gmail / Google Workspace' }, { value: 'office365', label: 'Microsoft 365 / Outlook' }, { value: 'zoho', label: 'Zoho Mail' }, { value: 'rediff', label: 'Rediffmail Pro' }]} />
          <Input id="mail-host" label="SMTP host" value={f.smtp_host} onChange={(e) => set('smtp_host', e.target.value.trim())} placeholder="smtp.gmail.com" disabled={!editable} />
          <Input id="mail-port" label="Port" type="number" value={String(f.smtp_port)} onChange={(e) => set('smtp_port', Number(e.target.value))} hint="587 = STARTTLS, 465 = SSL/TLS" disabled={!editable} />
          <div className="flex items-end pb-2">
            <Checkbox label="SSL / TLS from the start (port 465)" checked={f.smtp_secure} onChange={(v) => set('smtp_secure', v)} disabled={!editable} />
          </div>
          <Input id="mail-username" label="Username (login)" value={f.smtp_username} onChange={(e) => set('smtp_username', e.target.value.trim())} placeholder="purchase@yourcompany.com" autoComplete="off" disabled={!editable} />
          <Field label="Password / app password" hint={f.has_password ? 'A password is saved (hidden). Leave blank to keep it.' : 'Not saved yet'}>
            <input id="mail-password" className="input" type="password" value={password} autoComplete="new-password"
              placeholder={f.has_password ? '•••••••• (saved)' : ''} onChange={(e) => { setPassword(e.target.value); setClearPassword(false); }} disabled={!editable} />
          </Field>
          {f.has_password && (
            <div className="flex items-end pb-2">
              <Checkbox label="Remove the saved password" checked={clearPassword} onChange={(v) => { setClearPassword(v); if (v) setPassword(''); }} disabled={!editable} />
            </div>
          )}
        </FormSection>
        {preset && PRESETS[preset] && <p className="-mt-2 mb-4 flex items-center gap-1.5 text-small text-ink-secondary"><ShieldCheck size={14} /> {PRESETS[preset].note}</p>}

        <FormSection title="Sender" cols={2}>
          <Input id="mail-from-name" label="From name" value={f.from_name} onChange={(e) => set('from_name', e.target.value)} placeholder="ABC Knits - Purchase" disabled={!editable} />
          <Input id="mail-from-email" label="From e-mail" required value={f.from_email} onChange={(e) => set('from_email', e.target.value.trim())} placeholder="purchase@yourcompany.com" hint="Usually the same as the login — most servers refuse another address" disabled={!editable} />
          <Input id="mail-reply-to" label="Reply-to (optional)" value={f.reply_to} onChange={(e) => set('reply_to', e.target.value.trim())} placeholder="merchandiser@yourcompany.com" disabled={!editable} />
          <Input id="mail-default-cc" label="Always CC (optional, comma separated)" value={f.default_cc} onChange={(e) => set('default_cc', e.target.value)} placeholder="accounts@yourcompany.com" disabled={!editable} />
        </FormSection>

        <FormSection title="Purchase order mail" description="Placeholders: {PO_NO}, {SUPPLIER}, {COMPANY}, {PO_DATE}" cols={1}>
          <Input id="mail-subject-tpl" label="Subject" value={f.po_subject_tpl} onChange={(e) => set('po_subject_tpl', e.target.value)} maxLength={300} disabled={!editable} />
          <Field label="Message">
            <textarea id="mail-body-tpl" className="input resize-y" rows={7} value={f.po_body_tpl} onChange={(e) => set('po_body_tpl', e.target.value)} maxLength={5000} disabled={!editable} />
          </Field>
          <Checkbox label="Mail is switched on for this company" checked={f.is_active} onChange={(v) => set('is_active', v)} disabled={!editable} />
        </FormSection>

        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-body text-red-700" id="mail-error">{error}</p>}
        <div className="flex justify-end">
          <button type="button" id="mail-save" className="btn-primary" onClick={() => void save()} disabled={busy || !editable}>
            {busy ? <Spinner size={14} /> : <Save size={15} />} Save mail settings
          </button>
        </div>
      </div>

      <div className="card p-5">
        <h3 className="mb-1 text-body font-semibold text-ink">Send a test mail</h3>
        <p className="mb-3 text-small text-ink-secondary">Save first, then send a test to your own address to check the server, login and sender.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input id="mail-test-to" label="To" value={testTo} onChange={(e) => setTestTo(e.target.value.trim())} placeholder="you@yourcompany.com" className="w-full sm:w-80" />
          <button type="button" id="mail-test-send" className="btn-secondary" onClick={() => void test()} disabled={testing || !testTo || !editable || !f.configured}>
            {testing ? <Spinner size={14} /> : <Send size={15} />} Send test
          </button>
        </div>
        {testResult && (
          <p id="mail-test-result" className={`mt-3 rounded-lg px-3 py-2 text-body ${testResult.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{testResult.msg}</p>
        )}
      </div>
    </div>
  );
}
