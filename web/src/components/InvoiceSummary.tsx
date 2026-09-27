import { fmtDecimal } from '../lib/format';
import {
  autoRoundOff, TCS_SECTIONS, TDS_SECTIONS,
  type GstMode, type InvoiceCharges, type InvoiceTotals,
} from '../lib/invoiceCalc';

/**
 * Common invoice financial summary block — identical on every purchase /
 * inward screen (Bills Inward, Yarn / Fabric / Trim / General GRN).
 * Totals come from computeInvoice() in lib/invoiceCalc.ts; this component
 * only renders them and edits the optional heads (all default 0).
 */
interface InvoiceSummaryProps {
  totals: InvoiceTotals;
  value: InvoiceCharges;
  onChange: (patch: Partial<InvoiceCharges>) => void;
  gstMode: GstMode;
  currencySymbol?: string;
  currencyCode?: string;
  /** Import purchase: show insurance, customs duty and clearing heads. */
  showLandedCost?: boolean;
  /** Foreign currency: show the INR equivalent at this rate. */
  exchangeRate?: number;
  readOnly?: boolean;
  title?: string;
  className?: string;
}

const numCls =
  'w-24 text-[11px] text-right font-mono border border-slate-300 rounded px-1.5 py-0.5 bg-white focus:border-brand-500 focus:outline-none disabled:bg-slate-50';
const pctCls =
  'w-14 text-[11px] text-right border border-slate-300 rounded px-1 py-0.5 bg-white focus:border-brand-500 focus:outline-none disabled:bg-slate-50';
const selCls =
  'text-[11px] border border-slate-300 rounded px-1 py-0.5 bg-white max-w-[9.5rem] focus:border-brand-500 focus:outline-none disabled:bg-slate-50';

const GST_MODE_LABEL: Record<GstMode, string> = {
  INTRA_STATE: 'CGST + SGST',
  INTER_STATE: 'IGST',
  IMPORT: 'IGST (Import)',
};

export function InvoiceSummary({
  totals: t, value: v, onChange, gstMode,
  currencySymbol = '₹', currencyCode = 'INR',
  showLandedCost = false, exchangeRate, readOnly = false,
  title = 'Invoice Financial Summary', className = '',
}: InvoiceSummaryProps) {
  const cs = currencySymbol;
  const money = (x: number) => `${cs}${fmtDecimal(x, 2)}`;
  const num = (x: string) => (x === '' ? 0 : Number(x) || 0);
  const singleRate = t.gstGroups.length === 1 ? t.gstGroups[0].rate : null;
  const sign = Number(v.other_charges_sign) < 0 ? -1 : 1;
  const fx = Number(exchangeRate) || 1;

  const amountRow = (label: string, key: keyof InvoiceCharges) => (
    <div className="flex items-center justify-between py-0.5 text-slate-700">
      <span>{label}</span>
      <input
        type="number" min="0" step="0.01" disabled={readOnly}
        value={Number(v[key]) || 0}
        onChange={(e) => onChange({ [key]: num(e.target.value) })}
        className={numCls}
      />
    </div>
  );

  return (
    <div className={`p-4 bg-brand-50/40 rounded-xl border border-brand-200/80 space-y-1.5 text-xs ${className}`}>
      <div className="flex items-center justify-between pb-1 border-b border-brand-200/60">
        <h4 className="text-xs font-bold text-brand-900 uppercase tracking-wider">{title}</h4>
        <span className="font-semibold text-[11px] text-brand-700">{GST_MODE_LABEL[gstMode]}</span>
      </div>

      <div className="flex items-center justify-between py-0.5">
        <span className="text-slate-600">Taxable Subtotal</span>
        <span className="font-bold text-slate-900 text-sm font-mono">{money(t.taxable)}</span>
      </div>

      {gstMode === 'INTRA_STATE' ? (
        <>
          <div className="flex items-center justify-between py-0.5 text-slate-700">
            <span className="pl-2 text-slate-500">CGST{singleRate !== null ? ` @ ${singleRate / 2}%` : ''}</span>
            <span className="font-medium font-mono">{money(t.cgst)}</span>
          </div>
          <div className="flex items-center justify-between py-0.5 text-slate-700">
            <span className="pl-2 text-slate-500">SGST{singleRate !== null ? ` @ ${singleRate / 2}%` : ''}</span>
            <span className="font-medium font-mono">{money(t.sgst)}</span>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between py-0.5 text-slate-700">
          <span className="pl-2 text-slate-500">IGST{singleRate !== null ? ` @ ${singleRate}%` : ''}</span>
          <span className="font-medium font-mono">{money(t.igst)}</span>
        </div>
      )}

      {amountRow('Freight', 'freight_charges')}
      {showLandedCost && (
        <>
          {amountRow('Insurance', 'insurance')}
          {amountRow('Customs Duty', 'customs_duty')}
          {amountRow('Clearing / CHA Charges', 'clearing_charges')}
        </>
      )}

      {/* Other charges: labelled, added or deducted */}
      <div className="flex items-center justify-between gap-2 py-0.5 text-slate-700">
        <input
          type="text" maxLength={80} disabled={readOnly}
          value={v.other_charges_label ?? ''}
          placeholder="Other charges"
          onChange={(e) => onChange({ other_charges_label: e.target.value })}
          className="flex-1 min-w-0 text-[11px] border border-slate-300 rounded px-1.5 py-0.5 bg-white focus:border-brand-500 focus:outline-none disabled:bg-slate-50"
        />
        <div className="flex rounded border border-slate-300 overflow-hidden text-[11px] font-bold">
          {([1, -1] as const).map((sg) => (
            <button
              key={sg} type="button" disabled={readOnly}
              onClick={() => onChange({ other_charges_sign: sg })}
              className={`px-1.5 py-0.5 ${sign === sg ? (sg > 0 ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white') : 'bg-white text-slate-500'}`}
              title={sg > 0 ? 'Add to invoice' : 'Deduct from invoice'}
            >
              {sg > 0 ? '+' : '−'}
            </button>
          ))}
        </div>
        <input
          type="number" min="0" step="0.01" disabled={readOnly}
          value={Number(v.other_charges) || 0}
          onChange={(e) => onChange({ other_charges: Math.abs(num(e.target.value)) })}
          className={numCls}
        />
      </div>

      {/* TCS — collected by the seller, added */}
      <div className="flex items-center justify-between gap-2 py-0.5 text-slate-700">
        <div className="flex items-center gap-1.5">
          <span>TCS</span>
          <select
            disabled={readOnly} value={v.tcs_section ?? ''} className={selCls}
            onChange={(e) => {
              const sec = TCS_SECTIONS.find((x) => x.value === e.target.value);
              onChange({ tcs_section: e.target.value, tcs_pct: sec ? sec.pct : 0 });
            }}
          >
            <option value="">None</option>
            {TCS_SECTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
          <input
            type="number" min="0" step="0.01" disabled={readOnly}
            value={Number(v.tcs_pct) || 0}
            onChange={(e) => onChange({ tcs_pct: num(e.target.value) })}
            className={pctCls}
          />
          <span className="text-[10px] text-slate-400">%</span>
        </div>
        <span className="font-bold text-emerald-700 font-mono">+ {money(t.tcs)}</span>
      </div>

      {/* TDS — deducted by us, on taxable value */}
      <div className="flex items-center justify-between gap-2 py-0.5 text-slate-700">
        <div className="flex items-center gap-1.5">
          <span>TDS</span>
          <select
            disabled={readOnly} value={v.tds_section ?? ''} className={selCls}
            onChange={(e) => {
              const sec = TDS_SECTIONS.find((x) => x.value === e.target.value);
              onChange({ tds_section: e.target.value, tds_pct: sec ? sec.pct : 0 });
            }}
          >
            <option value="">None</option>
            {TDS_SECTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
          <input
            type="number" min="0" step="0.01" disabled={readOnly}
            value={Number(v.tds_pct) || 0}
            onChange={(e) => onChange({ tds_pct: num(e.target.value) })}
            className={pctCls}
          />
          <span className="text-[10px] text-slate-400">%</span>
        </div>
        <span className="font-bold text-red-600 font-mono">− {money(t.tds)}</span>
      </div>

      <div className="flex items-center justify-between py-0.5 text-slate-700">
        <span>Round Off</span>
        <div className="flex items-center gap-1.5">
          {!readOnly && (
            <button
              type="button"
              onClick={() => onChange({ round_off: autoRoundOff(t) })}
              className="text-[10px] font-semibold text-brand-700 hover:underline"
            >
              Auto
            </button>
          )}
          <input
            type="number" step="0.01" disabled={readOnly}
            value={Number(v.round_off) || 0}
            onChange={(e) => onChange({ round_off: num(e.target.value) })}
            className={numCls}
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-brand-200 text-sm">
        <span className="font-extrabold text-brand-900">Net Payable ({currencyCode})</span>
        <span className="font-extrabold text-brand-900 text-base font-mono">{money(t.net)}</span>
      </div>

      {fx !== 1 && (
        <div className="flex items-center justify-between pt-1 text-[11px] font-bold text-emerald-900">
          <span>INR equivalent @ {fx}</span>
          <span className="font-mono">₹{fmtDecimal(t.net * fx, 2)}</span>
        </div>
      )}
    </div>
  );
}
