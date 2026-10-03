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

/** PO list for a GRN picker: open POs only (fully received / short closed ones are done). */
export const openForGrn = (p: any) => !['FULLY_RECEIVED', 'SHORT_CLOSED'].includes(String(p.receipt_status ?? ''));
