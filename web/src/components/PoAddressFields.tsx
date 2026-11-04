import { useEffect } from 'react';
import { Building2, Truck, RotateCcw } from 'lucide-react';
import { useMyCompanyAddress } from '../lib/myCompany';
import { useLookup } from '../hooks/useLookup';

/**
 * PO billing + shipping (delivery) address (client 04-Nov-2026, clip 5) — printed on the PO PDF.
 * Billing defaults to our company address. "Shipping address same as billing" ticked → shipping = billing (kept in
 * step as billing is edited); unticked → type the delivery address or pick a unit / job worker to fill it.
 *
 *   <PoAddressFields value={{ billing_address, shipping_address, ship_same_as_billing }} onChange={(v) => …} />
 *
 * Save the three fields with the PO (API fields billing_address, shipping_address, ship_same_as_billing on
 * /purchase-orders, /trim-pos and /general-purchases). Ids: #po-billing-address #po-ship-same #po-shipping-address
 * #po-ship-to-unit.
 */
export interface PoAddressValue {
  billing_address: string;
  shipping_address: string;
  ship_same_as_billing: boolean;
}

export function PoAddressFields({ value, onChange, disabled }: {
  value: PoAddressValue;
  onChange: (next: PoAddressValue) => void;
  disabled?: boolean;
}) {
  const companyAddress = useMyCompanyAddress();
  const units = useLookup('process-units');

  // billing starts as our company address (once it has loaded) when nothing is stored yet — also after the PO loads blank
  const billingBlank = !value.billing_address;
  useEffect(() => {
    if (companyAddress && !value.billing_address && !disabled) {
      onChange({ ...value, billing_address: companyAddress, shipping_address: value.ship_same_as_billing ? companyAddress : value.shipping_address });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyAddress, billingBlank]);

  const setBilling = (billing: string) =>
    onChange({ ...value, billing_address: billing, shipping_address: value.ship_same_as_billing ? billing : value.shipping_address });
  const setSame = (same: boolean) =>
    onChange({ ...value, ship_same_as_billing: same, shipping_address: same ? value.billing_address : (value.shipping_address === value.billing_address ? '' : value.shipping_address) });
  const pickUnit = (id: string) => {
    if (!id) return;
    if (id === '__company') { onChange({ ...value, shipping_address: companyAddress }); return; }
    const u = (units.data as any[] | undefined)?.find((p) => String(p.id) === id);
    if (!u) return;
    onChange({ ...value, shipping_address: [u.label, u.default_address, u.gstin ? `GSTIN: ${u.gstin}` : null].filter(Boolean).join('\n') });
  };

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2" id="po-address-fields">
      <div className="rounded-xl border border-surface-border bg-white p-4 shadow-xs">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-body font-semibold text-ink"><Building2 size={14} className="text-brand-600" /> Billing address</span>
          {!disabled && companyAddress && (
            <button type="button" className="flex items-center gap-1 text-small font-medium text-brand-700 hover:underline"
              onClick={() => setBilling(companyAddress)} title="Use our company address">
              <RotateCcw size={12} /> Company address
            </button>
          )}
        </div>
        <textarea id="po-billing-address" rows={4} className="input w-full resize-y" value={value.billing_address} disabled={disabled}
          onChange={(e) => setBilling(e.target.value)} placeholder="Our company billing address with GSTIN" />
      </div>
      <div className="rounded-xl border border-surface-border bg-white p-4 shadow-xs">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-body font-semibold text-ink"><Truck size={14} className="text-emerald-600" /> Shipping (delivery) address</span>
          <label className="flex cursor-pointer items-center gap-2 text-small text-ink">
            <input id="po-ship-same" type="checkbox" className="h-4 w-4 rounded border-surface-input text-brand-600"
              checked={value.ship_same_as_billing} disabled={disabled} onChange={(e) => setSame(e.target.checked)} />
            Shipping address same as billing
          </label>
        </div>
        {!value.ship_same_as_billing && (
          <select id="po-ship-to-unit" className="input mb-2" value="" disabled={disabled} onChange={(e) => pickUnit(e.target.value)}>
            <option value="">Pick a unit / job worker to fill the address…</option>
            {companyAddress && <option value="__company">Our company address</option>}
            {((units.data as any[]) ?? []).map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        )}
        <textarea id="po-shipping-address" rows={value.ship_same_as_billing ? 4 : 3} className="input w-full resize-y"
          value={value.ship_same_as_billing ? value.billing_address : value.shipping_address}
          disabled={disabled || value.ship_same_as_billing}
          onChange={(e) => onChange({ ...value, shipping_address: e.target.value })}
          placeholder="Delivery address (our unit, dyeing mill, job worker…)" />
      </div>
    </div>
  );
}
