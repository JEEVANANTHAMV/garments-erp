/**
 * PO billing / shipping address (client 04-Nov-2026, clip 5): with "Shipping address same as billing" ticked the
 * stored shipping address is the billing address, so the print and every report read one value.
 */
export function syncShipToBilling(data: Record<string, unknown>, before?: Record<string, unknown> | null) {
  const same = data.ship_same_as_billing !== undefined ? Number(data.ship_same_as_billing) : Number(before?.ship_same_as_billing ?? 0);
  if (!same) return;
  const billing = data.billing_address !== undefined ? data.billing_address : before?.billing_address;
  data.shipping_address = billing ?? null;
}
