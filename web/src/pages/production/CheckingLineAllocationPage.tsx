import { LineAllocationPage } from './SewingLineAllocationPage';

/**
 * Checking Line Allocation — same screen as Sewing Line Allocation (developer
 * doc §11). Bundles come from sewn good stock not yet sent on to finishing.
 */
export function CheckingLineAllocationPage() {
  return <LineAllocationPage proc="checking" />;
}

export default CheckingLineAllocationPage;
