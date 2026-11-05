import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';

/**
 * Printout design for one print (client voice notes 05-Nov-2026): "Colour" (light professional colour) or
 * "Black & White" (bordered, for B/W printers). '' = the company default (Admin → Settings → PRINT_TEMPLATE).
 * The choice is remembered in this browser and sent as ?template=colour|bw to the PDF endpoints.
 *
 *   const [template, setTemplate] = usePrintTemplate();
 *   <PrintTemplatePicker value={template} onChange={setTemplate} id="po-print-template" />
 *   api.get(url, { params: { ...printTemplateParam(template) } })
 */
export type PrintTemplateChoice = '' | 'colour' | 'bw';

const KEY = 'erp.print-template';
const EVENT = 'erp-print-template';

function readChoice(): PrintTemplateChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'colour' || v === 'bw' ? v : '';
  } catch { return ''; }
}

/** The remembered choice, shared by every print button on the page. */
export function usePrintTemplate(): [PrintTemplateChoice, (v: PrintTemplateChoice) => void] {
  const [value, setValue] = useState<PrintTemplateChoice>(readChoice);
  useEffect(() => {
    const on = () => setValue(readChoice());
    window.addEventListener(EVENT, on);
    window.addEventListener('storage', on);
    return () => { window.removeEventListener(EVENT, on); window.removeEventListener('storage', on); };
  }, []);
  const set = useCallback((v: PrintTemplateChoice) => {
    try { if (v) window.localStorage.setItem(KEY, v); else window.localStorage.removeItem(KEY); } catch { /* private mode: this page only */ }
    setValue(v);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [value, set];
}

/** `{ template: 'colour' | 'bw' }` for the request, nothing for the company default. */
export const printTemplateParam = (t: PrintTemplateChoice): { template?: 'colour' | 'bw' } => (t ? { template: t } : {});

export function PrintTemplatePicker({ value, onChange, id, className }: {
  value: PrintTemplateChoice; onChange: (v: PrintTemplateChoice) => void; id?: string; className?: string;
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as PrintTemplateChoice)} aria-label="Print design"
      title="Print design for this print (default = Admin → Settings → PRINT_TEMPLATE)"
      className={clsx('input h-9 w-auto py-1 text-small', className)}>
      <option value="">Design: company default</option>
      <option value="colour">Design: Colour</option>
      <option value="bw">Design: Black &amp; White</option>
    </select>
  );
}
