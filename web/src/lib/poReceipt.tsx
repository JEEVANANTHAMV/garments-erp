import { fmtDecimal } from './format';

/**
 * PO receipt status on the GRN screens (client voice note 03-Oct-2026): a GRN is a PARTIAL delivery (more to come)
 * or the FINAL one (whatever is still pending on its PO lines is closed short). Each line shows where the PO line
 * stands after this receipt; the PO list shows Pending / Partially received / Fully received / Short closed.
 */
export type ReceiptType = 'PARTIAL' | 'FINAL';
export const RECEIPT_LABEL: Record<string, [string, string]> = {
  PENDING: ['Pending', 'bg-slate-100 text-slate-600'],
  PARTIALLY_RECEIVED: ['Partially received', 'bg-amber-100 text-amber-800'],
  FULLY_RECEIVED: ['Fully received', 'bg-emerald-100 text-emerald-800'],
  SHORT_CLOSED: ['Short closed', 'bg-slate-200 text-slate-700'],
};
export function ReceiptStatusBadge({ value }: { value?: string | null }) {
  const [l, c] = RECEIPT_LABEL[String(value ?? 'PENDING')] ?? RECEIPT_LABEL.PENDING;
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold ${c}`}>{l}</span>;
}

/** Where a PO line stands after this receipt. */
export function lineAfterReceipt(ordered: number | null | undefined, prevReceived: number | null | undefined, thisAccepted: number, type: ReceiptType) {
  if (ordered == null) return null;
  const done = (Number(prevReceived) || 0) + (Number(thisAccepted) || 0);
  const pending = Math.max(0, Number(ordered) - done);
  if (pending <= 0.0005) return { status: 'FULLY_RECEIVED', text: 'Fully received', pending: 0 };
  if (type === 'FINAL') return { status: 'SHORT_CLOSED', text: `Closed short — ${fmtDecimal(pending)} will not come`, pending };
  return { status: 'PARTIALLY_RECEIVED', text: `Partially received — ${fmtDecimal(pending)} still to come`, pending };
}
export function LineReceiptChip({ ordered, prev, accepted, type }: { ordered?: number | null; prev?: number | null; accepted: number; type: ReceiptType }) {
  const r = lineAfterReceipt(ordered, prev, accepted, type);
  if (!r) return null;
  const [, c] = RECEIPT_LABEL[r.status];
  return <div className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${c}`} title={r.text}>{r.text}</div>;
}

/** Partial / Final chooser for the GRN header. */
export function ReceiptTypeChooser({ value, onChange, disabled, id = 'grn-receipt' }: { value: ReceiptType; onChange: (v: ReceiptType) => void; disabled?: boolean; id?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]" id={id}>
      <span className="font-semibold text-slate-700">This delivery is:</span>
      <label className="flex items-center gap-1.5"><input type="radio" disabled={disabled} checked={value === 'PARTIAL'} onChange={() => onChange('PARTIAL')} id={`${id}-partial`} /> Partial — more to come on the PO</label>
      <label className="flex items-center gap-1.5"><input type="radio" disabled={disabled} checked={value === 'FINAL'} onChange={() => onChange('FINAL')} id={`${id}-final`} /> Final — last delivery; close what is still pending</label>
    </div>
  );
}

/**
 * Partial / Final per GRN line (client voice note 04-Oct-2026): one PO carries several jobs and one job may come in half
 * while another is complete, so each PO line is marked on its own row.
 */
export function LineReceiptSelect({ value, onChange, disabled, id }: { value?: ReceiptType | null; onChange: (v: ReceiptType) => void; disabled?: boolean; id?: string }) {
  const v = value === 'FINAL' ? 'FINAL' : 'PARTIAL';
  return (
    <div className="mt-1 inline-flex overflow-hidden rounded border border-slate-300 text-[10px] font-semibold" id={id} title="Partial = more to come on this PO line · Final = last delivery, close what is still pending">
      {(['PARTIAL', 'FINAL'] as ReceiptType[]).map((t) => (
        <button key={t} type="button" disabled={disabled} id={id ? `${id}-${t.toLowerCase()}` : undefined} onClick={() => onChange(t)}
          className={`px-1.5 py-0.5 ${v === t ? (t === 'FINAL' ? 'bg-slate-700 text-white' : 'bg-amber-500 text-white') : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
          {t === 'FINAL' ? 'Final' : 'Partial'}
        </button>
      ))}
    </div>
  );
}

/** Badge for a saved GRN line. */
export function LineReceiptBadge({ value }: { value?: string | null }) {
  if (value !== 'FINAL' && value !== 'PARTIAL') return null;
  return <span className={`ml-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${value === 'FINAL' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'}`}>{value === 'FINAL' ? 'Final' : 'Partial'}</span>;
}

/** Header strip: the choice is per line; quick buttons set every PO line at once. */
export function ReceiptAllLines({ onSet, finals, total, id = 'grn-receipt' }: { onSet: (v: ReceiptType) => void; finals: number; total: number; id?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]" id={id}>
      <span className="font-semibold text-slate-700">Partial / Final is set on each line below</span>
      <span className="text-slate-500">({finals} of {total} line{total === 1 ? '' : 's'} final)</span>
      <span className="ml-auto text-slate-500">Set all:</span>
      <button type="button" id={`${id}-partial`} className="rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-50" onClick={() => onSet('PARTIAL')}>Partial</button>
      <button type="button" id={`${id}-final`} className="rounded border border-slate-400 bg-white px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-100" onClick={() => onSet('FINAL')}>Final</button>
    </div>
  );
}

/** GRN-level summary sent with the save: FINAL when every PO line is final. */
export const summaryReceiptType = (lines: { po_line_id?: unknown; receipt_type?: ReceiptType | null }[]): ReceiptType => {
  const po = lines.filter((l) => l.po_line_id);
  return po.length > 0 && po.every((l) => l.receipt_type === 'FINAL') ? 'FINAL' : 'PARTIAL';
};

/** PO list for a GRN picker: open POs only (fully received / short closed ones are done). */
export const openForGrn = (p: any) => !['FULLY_RECEIVED', 'SHORT_CLOSED'].includes(String(p.receipt_status ?? ''));
