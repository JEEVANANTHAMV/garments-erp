import { useMyCompany } from '../lib/myCompany';

/**
 * Our company's name + address at the top of an on-screen print (client 05-Nov-2026: no software name on any
 * printout — only the company's own name and address).
 */
export function CompanyPrintHeading() {
  const { data: c } = useMyCompany();
  if (!c) return null;
  const address = [c.address_line1, c.address_line2, [c.city, c.pincode].filter(Boolean).join(' - '), c.state].filter(Boolean).join(', ');
  return (
    <>
      <h1 className="text-xl font-bold uppercase tracking-wider text-ink">{c.legal_name || c.trade_name}</h1>
      {address && <p className="text-xs text-ink-secondary">{address}</p>}
      {c.gstin && <p className="text-xs text-ink-secondary">GSTIN: {c.gstin}</p>}
    </>
  );
}
