import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, FileDown, Mail, Paperclip, X, Send, AlertTriangle, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { api, http, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useToast } from '../hooks/useToast';
import { Modal, Spinner, Field } from './ui';
import { PrintTemplatePicker, printTemplateParam, usePrintTemplate, type PrintTemplateChoice } from './PrintTemplatePicker';

/**
 * Print / PDF / Email for a purchase order (client 04-Nov-2026: "click Mail after the PO → it becomes a PDF and the
 * mail goes to the supplier"). The PDF is made by the server (GET /purchase-docs/:type/:id/pdf) and fetched with the
 * signed-in user's token as a blob — a plain new-tab link would not carry the token.
 *
 *   <PoDocumentActions type="yarn" id={po.id} poNo={po.po_no} status={po.approval_state} />
 *
 * Stable ids (full mode): #po-print-template (Colour / Black & White, remembered) #po-print #po-pdf #po-email #po-last-sent, and in the mail popup #po-mail-to #po-mail-cc
 * #po-mail-subject #po-mail-body #po-mail-send #po-mail-fallback #po-mail-error. `compact` = icon buttons for list
 * rows (no ids, data-po-action instead).
 */
export type PoDocType = 'yarn' | 'fabric' | 'trim' | 'general';

interface MailDefaults {
  doc_type: string; doc_no: string; status: string;
  to: string[]; cc: string[]; subject: string; body: string; attachment: string; supplier_name: string;
  configured: boolean; not_configured_message: string | null; blocked_reason: string | null; from: string | null;
  last_sent: MailLog | null;
}
interface MailLog {
  id: number; to_emails: string; cc_emails: string | null; subject: string; status: 'SENT' | 'FAILED';
  error_message: string | null; sent_at: string; sent_by_name: string | null; sent_by_username: string | null;
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const MAX_RECIPIENTS = 20;
const DRAFTISH = ['DRAFT', 'PENDING'];

const pdfUrl = (type: PoDocType, id: number | string) => `/purchase-docs/${type}/${id}/pdf`;

/** The PDF as a blob with the app's auth (401 still goes through the token refresh); error bodies are read as JSON. */
async function fetchPdf(type: PoDocType, id: number | string, download = false, template: PrintTemplateChoice = ''): Promise<{ blob: Blob; name: string }> {
  const r = await api.get<Blob>(pdfUrl(type, id), {
    params: { ...(download ? { download: 1 } : {}), ...printTemplateParam(template) }, responseType: 'blob', timeout: 60_000,
    validateStatus: (s) => s !== 401 && s < 500,   // 401 → interceptor refresh; 4xx read here for the real message
  });
  if (r.status !== 200) {
    let msg = `Could not make the PDF (HTTP ${r.status})`;
    try { msg = JSON.parse(await (r.data as Blob).text())?.error?.message ?? msg; } catch { /* not JSON */ }
    throw new ApiError(r.status, 'PDF_FAILED', msg);
  }
  const cd = String(r.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `PO-${id}.pdf`;
  return { blob: new Blob([r.data], { type: 'application/pdf' }), name };
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function PoDocumentActions({ type, id, poNo, status, compact = false, className }: {
  type: PoDocType;
  id: number | string;
  poNo?: string | null;
  /** The PO's status / approval state — DRAFT / PENDING show a hint on Email (the server decides). */
  status?: string | null;
  /** Icon-only buttons for list rows. */
  compact?: boolean;
  className?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  const [mailOpen, setMailOpen] = useState(false);
  const [template, setTemplate] = usePrintTemplate();   // Colour / Black & White for Print + PDF (mail uses the company default)
  const label = poNo || `PO ${id}`;

  const log = useQuery({
    queryKey: ['po-mail-log', type, String(id)],
    queryFn: async () => (await http.get<{ data: MailLog[] }>(`/purchase-docs/${type}/${id}/mail-log`)).data,
    enabled: !compact && !!id,
    staleTime: 60_000,
    retry: false,
  });
  const lastSent = log.data?.find((l) => l.status === 'SENT');

  const print = async () => {
    // open the tab inside the click (pop-up blockers), fill it when the PDF arrives
    const w = window.open('', '_blank');
    setBusy('print');
    try {
      const { blob } = await fetchPdf(type, id, false, template);
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    } catch (e) {
      w?.close();
      toast(errMsg(e), 'error');
    } finally { setBusy(null); }
  };
  const download = async () => {
    setBusy('pdf');
    try {
      const { blob, name } = await fetchPdf(type, id, true, template);
      saveBlob(blob, name);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };

  const btn = compact
    ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-hover hover:text-brand-700 disabled:opacity-50'
    : 'btn-secondary';
  const isDraft = DRAFTISH.includes(String(status ?? '').toUpperCase());

  return (
    <div className={clsx('inline-flex flex-wrap items-center gap-2', compact && 'gap-0.5', className)}
      onClick={compact ? (e) => e.stopPropagation() : undefined}>
      {!compact && <PrintTemplatePicker value={template} onChange={setTemplate} id="po-print-template" />}
      <button type="button" className={btn} onClick={() => void print()} disabled={!!busy}
        id={compact ? undefined : 'po-print'} data-po-action="print" title={`Print ${label}`} aria-label={`Print ${label}`}>
        {busy === 'print' ? <Spinner size={14} /> : <Printer size={15} />}{!compact && ' Print'}
      </button>
      <button type="button" className={btn} onClick={() => void download()} disabled={!!busy}
        id={compact ? undefined : 'po-pdf'} data-po-action="pdf" title={`Download ${label} as PDF`} aria-label={`Download ${label} as PDF`}>
        {busy === 'pdf' ? <Spinner size={14} /> : <FileDown size={15} />}{!compact && ' PDF'}
      </button>
      <button type="button" className={btn} onClick={() => setMailOpen(true)}
        id={compact ? undefined : 'po-email'} data-po-action="email"
        title={isDraft ? 'Approve the PO before sending it to the supplier' : `E-mail ${label} to the supplier`} aria-label={`E-mail ${label}`}>
        <Mail size={15} />{!compact && ' Email'}
      </button>
      {!compact && lastSent && (
        <span id="po-last-sent" className="text-small text-ink-secondary">
          Last sent: {fmtDateTime(lastSent.sent_at)} to {lastSent.to_emails}{lastSent.sent_by_name || lastSent.sent_by_username ? ` by ${lastSent.sent_by_name || lastSent.sent_by_username}` : ''}
        </span>
      )}
      {mailOpen && <PoMailModal type={type} id={id} label={label} onClose={() => setMailOpen(false)} />}
    </div>
  );
}

/** Address chips: type / paste, Enter or comma adds; invalid ones are shown red and block sending. */
function EmailChips({ id, value, onChange, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next); setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', 'Tab'].includes(e.key) && draft.trim()) { e.preventDefault(); commit(draft); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="input flex min-h-[2.5rem] flex-wrap items-center gap-1.5 py-1.5" onClick={() => document.getElementById(id)?.focus()}>
      {value.map((em) => (
        <span key={em} data-chip={em}
          className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small',
            EMAIL.test(em) ? 'bg-brand-50 text-brand-800' : 'bg-red-50 text-red-700 ring-1 ring-red-300')}>
          {em}
          <button type="button" aria-label={`Remove ${em}`} onClick={() => onChange(value.filter((x) => x !== em))}
            className="rounded-full text-ink-muted hover:text-ink"><X size={12} /></button>
        </span>
      ))}
      <input id={id} value={draft} placeholder={value.length ? '' : placeholder}
        onChange={(e) => { const v = e.target.value; if (/[,;]/.test(v)) commit(v); else setDraft(v); }}
        onKeyDown={onKey} onBlur={() => commit(draft)}
        className="min-w-[10rem] flex-1 border-0 bg-transparent p-0 text-body outline-none focus:ring-0" />
    </div>
  );
}

function PoMailModal({ type, id, label, onClose }: { type: PoDocType; id: number | string; label: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const defaults = useQuery({
    queryKey: ['po-mail-defaults', type, String(id)],
    queryFn: async () => (await http.get<{ data: MailDefaults }>(`/purchase-docs/${type}/${id}/mail-defaults`)).data,
    staleTime: 0, retry: false,
  });
  const d = defaults.data;
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    if (d && !loaded) {
      setTo(d.to); setCc(d.cc); setSubject(d.subject); setBody(d.body); setLoaded(true);
      setNotConfigured(!d.configured);
    }
  }, [d, loaded]);

  const invalid = useMemo(() => [...to, ...cc].filter((x) => !EMAIL.test(x)), [to, cc]);
  const tooMany = to.length + cc.length > MAX_RECIPIENTS;
  const blocked = d?.blocked_reason ?? null;
  const canSend = !!d && !notConfigured && !blocked && to.length > 0 && !invalid.length && !tooMany && !!subject.trim() && !sending;

  const send = async () => {
    setError(null); setSending(true);
    try {
      const r = await http.post<{ data: { to: string[]; cc: string[]; message_id: string } }>(`/purchase-docs/${type}/${id}/email`, { to, cc, subject, body });
      toast(`${label} e-mailed to ${[...r.data.to, ...r.data.cc].join(', ')}`);
      void qc.invalidateQueries({ queryKey: ['po-mail-log', type, String(id)] });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MAIL_NOT_CONFIGURED') setNotConfigured(true);
      setError(errMsg(e));
      void qc.invalidateQueries({ queryKey: ['po-mail-log', type, String(id)] });
    } finally { setSending(false); }
  };

  /** No SMTP set up: download the PDF and open the user's own mail app with To / Subject / Body filled. */
  const fallback = async () => {
    setFallbackBusy(true); setError(null);
    try {
      const { blob, name } = await fetchPdf(type, id, true);   // a mailed PDF uses the company default design
      saveBlob(blob, name);
      const q = new URLSearchParams();
      if (cc.length) q.set('cc', cc.join(','));
      q.set('subject', subject);
      q.set('body', `${body}\n\n(Attach the downloaded file ${name})`);
      const href = `mailto:${to.map(encodeURIComponent).join(',')}?${q.toString().replace(/\+/g, '%20')}`;
      const a = document.createElement('a');
      a.href = href; a.id = 'po-mailto-link';
      document.body.appendChild(a); a.click(); a.remove();
      toast(`${name} downloaded — attach it to the mail that opened`, 'info');
    } catch (e) { setError(errMsg(e)); } finally { setFallbackBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`E-mail ${label}`} icon={<Mail size={16} />} size="lg"
      subtitle={d ? <>To the supplier {d.supplier_name}{d.from ? <> · from {d.from}</> : null}</> : undefined}
      footerStart={d ? <span className="inline-flex items-center gap-1.5" id="po-mail-attachment"><Paperclip size={14} /> {d.attachment}</span> : undefined}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        {notConfigured ? (
          <button type="button" id="po-mail-fallback" className="btn-primary" onClick={() => void fallback()} disabled={fallbackBusy || !d}>
            {fallbackBusy ? <Spinner size={14} /> : <ExternalLink size={15} />} Download PDF &amp; open mail app
          </button>
        ) : (
          <button type="button" id="po-mail-send" className="btn-primary" onClick={() => void send()} disabled={!canSend}>
            {sending ? <Spinner size={14} /> : <Send size={15} />} {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </>}>
      {defaults.isLoading ? (
        <div className="flex items-center gap-2 py-8 text-body text-ink-secondary"><Spinner size={16} /> Preparing the mail…</div>
      ) : defaults.error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-body text-red-700" id="po-mail-error">{errMsg(defaults.error)}</p>
      ) : (
        <div className="space-y-3">
          {notConfigured && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-body text-amber-900" id="po-mail-not-configured">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">{d?.not_configured_message || 'Mail is not set up — Admin → Mail settings'}</p>
                <p className="text-small">You can still send it from your own mail app: the PDF is downloaded and a new mail opens with the address, subject and message filled in — attach the downloaded file.</p>
              </div>
            </div>
          )}
          {blocked && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-body text-amber-900" id="po-mail-blocked">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {blocked}
            </div>
          )}
          <Field label="To" required hint={!to.length ? 'No e-mail on the supplier master — type the address (Enter or comma adds it)' : undefined}
            error={invalid.length ? `Not a valid e-mail address: ${invalid.join(', ')}` : tooMany ? `At most ${MAX_RECIPIENTS} recipients` : undefined}>
            <EmailChips id="po-mail-to" value={to} onChange={setTo} placeholder="supplier@example.com" />
          </Field>
          <Field label="CC">
            <EmailChips id="po-mail-cc" value={cc} onChange={setCc} placeholder="Optional" />
          </Field>
          <Field label="Subject" required>
            <input id="po-mail-subject" className="input" value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <textarea id="po-mail-body" className="input resize-y" rows={8} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
          </Field>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-body text-red-700" id="po-mail-error">{error}</p>}
          {d?.last_sent && (
            <p className="text-small text-ink-secondary">
              Last {d.last_sent.status === 'SENT' ? 'sent' : 'attempt (failed)'}: {fmtDateTime(d.last_sent.sent_at)} to {d.last_sent.to_emails}
              {d.last_sent.sent_by_name ? ` by ${d.last_sent.sent_by_name}` : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
