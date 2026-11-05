import { useEffect, useState } from 'react';
import { Download, Eye, FileText, Printer } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { LoadingBlock, Modal, Spinner } from './ui';
import { PrintTemplatePicker, printTemplateParam, usePrintTemplate, type PrintTemplateChoice } from './PrintTemplatePicker';

/**
 * Server-made PDF of a document (DCs on the shared print engine, client voice notes 05-Nov-2026): fetched as a
 * blob with the signed-in user's token, shown in a preview, printed through a hidden frame or downloaded.
 * `url` = the endpoint (GET …/:id/print) taking ?purpose=preview|print|download&template=colour|bw.
 *
 *   <DocPdfActions url={`/process-dcs/${id}/print`} idPrefix="pdc" label="DC" />      // picker + Preview + Print + PDF
 *   <DocPdfModal url={pdfUrl} title="Process DC JWC-00012" onClose={() => setPdfUrl(null)} idPrefix="pdc" />
 *
 * Stable ids: #<idPrefix>-print-template #<idPrefix>-preview #<idPrefix>-print #<idPrefix>-pdf, and in the
 * preview #<idPrefix>-pdf-frame #<idPrefix>-pdf-template #<idPrefix>-pdf-print #<idPrefix>-pdf-download.
 */
export type PdfPurpose = 'preview' | 'print' | 'download';

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export async function fetchDocPdf(url: string, purpose: PdfPurpose = 'preview', template: PrintTemplateChoice = '') {
  const r = await api.get<Blob>(url, {
    params: { purpose, ...printTemplateParam(template) }, responseType: 'blob', timeout: 60_000,
    validateStatus: (s) => s !== 401 && s < 500,   // 401 → interceptor refresh; 4xx read here for the real message
  });
  if (r.status !== 200) {
    let msg = `Could not make the PDF (HTTP ${r.status})`;
    try { msg = JSON.parse(await (r.data as Blob).text())?.error?.message ?? msg; } catch { /* not JSON */ }
    throw new ApiError(r.status, 'PDF_FAILED', msg);
  }
  const name = /filename="([^"]+)"/.exec(String(r.headers['content-disposition'] ?? ''))?.[1] ?? 'document.pdf';
  return { blob: new Blob([r.data], { type: 'application/pdf' }), name };
}

export function saveBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60_000);
}

/** Prints the PDF itself (the A4 page size is inside the PDF) through a hidden frame. */
export function printBlob(blob: Blob) {
  const u = URL.createObjectURL(blob);
  const f = document.createElement('iframe');
  f.style.position = 'fixed'; f.style.right = '0'; f.style.bottom = '0'; f.style.width = '0'; f.style.height = '0'; f.style.border = '0';
  f.src = u;
  f.onload = () => { try { f.contentWindow?.focus(); f.contentWindow?.print(); } catch { window.open(u, '_blank'); } };
  document.body.appendChild(f);
  setTimeout(() => { f.remove(); URL.revokeObjectURL(u); }, 120_000);
}

/** A4 PDF preview with the Colour / Black & White picker, Download and Print. */
export function DocPdfModal({ url, title, onClose, idPrefix = 'doc', onPrinted }: {
  url: string | null; title?: string; onClose: () => void; idPrefix?: string; onPrinted?: () => void;
}) {
  const toast = useToast();
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [template, setTemplate] = usePrintTemplate();
  useEffect(() => {
    if (!url) return;
    let alive = true; let made: string | null = null;
    setSrc(null);
    fetchDocPdf(url, 'preview', template).then(({ blob }) => { if (alive) { made = URL.createObjectURL(blob); setSrc(made); } })
      .catch((e) => { if (alive) toast(errMsg(e), 'error'); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [url, template]);
  const run = async (p: PdfPurpose) => {
    if (!url) return;
    setBusy(true);
    try { const { blob, name } = await fetchDocPdf(url, p, template); if (p === 'download') saveBlob(blob, name); else printBlob(blob); onPrinted?.(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!url} onClose={onClose} size="xl" title={title ?? 'Delivery challan'} subtitle="A4 portrait — print preview" icon={<FileText size={16} />}
      footer={<>
        <PrintTemplatePicker value={template} onChange={setTemplate} id={`${idPrefix}-pdf-template`} className="mr-auto" />
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run('download')} id={`${idPrefix}-pdf-download`}><Download size={14} /> Download PDF</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void run('print')} id={`${idPrefix}-pdf-print`}><Printer size={14} /> Print</button>
      </>}>
      {src ? <iframe title="PDF preview" src={src} className="h-[72vh] w-full rounded border border-surface-border" id={`${idPrefix}-pdf-frame`} /> : <LoadingBlock rows={6} />}
    </Modal>
  );
}

/** Inline buttons: design picker + Preview (opens the preview) + Print + PDF download. */
export function DocPdfActions({ url, idPrefix = 'doc', label = 'DC', title, disabled, disabledHint, onPrinted, className }: {
  url: string | null; idPrefix?: string; label?: string; title?: string; disabled?: boolean; disabledHint?: string;
  onPrinted?: () => void; className?: string;
}) {
  const toast = useToast();
  const [template, setTemplate] = usePrintTemplate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<PdfPurpose | null>(null);
  const off = disabled || !url;
  const run = async (p: PdfPurpose) => {
    if (!url) return;
    setBusy(p);
    try { const { blob, name } = await fetchDocPdf(url, p, template); if (p === 'download') saveBlob(blob, name); else printBlob(blob); onPrinted?.(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };
  const hint = off ? (disabledHint ?? `Save the ${label} first`) : undefined;
  return (
    <span className={clsx('inline-flex flex-wrap items-center gap-2', className)}>
      <PrintTemplatePicker value={template} onChange={setTemplate} id={`${idPrefix}-print-template`} />
      <button type="button" className="btn-secondary" disabled={off} title={hint ?? `Preview the ${label}`} onClick={() => setOpen(true)} id={`${idPrefix}-preview`}>
        <Eye size={14} /> Preview {label}
      </button>
      <button type="button" className="btn-secondary" disabled={off || !!busy} title={hint ?? `Print the ${label}`} onClick={() => void run('print')} id={`${idPrefix}-print`}>
        {busy === 'print' ? <Spinner size={14} /> : <Printer size={14} />} Print {label}
      </button>
      <button type="button" className="btn-secondary" disabled={off || !!busy} title={hint ?? `Download the ${label} as PDF`} onClick={() => void run('download')} id={`${idPrefix}-pdf`}>
        {busy === 'download' ? <Spinner size={14} /> : <Download size={14} />} PDF
      </button>
      {open && url && <DocPdfModal url={url} title={title} onClose={() => setOpen(false)} idPrefix={idPrefix} onPrinted={onPrinted} />}
    </span>
  );
}
