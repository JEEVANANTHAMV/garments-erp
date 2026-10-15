import { useQuery } from '@tanstack/react-query';
import { http } from './api';

/** The signed-in company's billing identity (GET /lookups/my-company — readable by any logged-in user). */
export interface MyCompany {
  id: number; company_code: string; legal_name: string; trade_name: string | null;
  gstin: string | null; pan: string | null; iec_code: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null; state: string | null;
  state_gst_code: string | null; pincode: string | null; phone: string | null; email: string | null;
  website: string | null; country: string | null;
}

export function useMyCompany() {
  return useQuery({
    queryKey: ['lookups', 'my-company'],
    queryFn: async () => (await http.get<{ data: MyCompany }>('/lookups/my-company')).data,
    staleTime: 5 * 60_000,
  });
}

/** Multi-line "Bill to" block: name, address lines, city - pincode, state, GSTIN. */
export function companyAddressBlock(c: MyCompany | null | undefined): string {
  if (!c) return '';
  const cityLine = [c.city, c.pincode].filter(Boolean).join(' - ');
  const lines = [
    c.legal_name || c.trade_name,
    c.address_line1,
    c.address_line2,
    [cityLine, c.state].filter(Boolean).join(', '),
    c.gstin ? `GSTIN: ${c.gstin}` : '',
  ];
  return lines.map((l) => (l ?? '').trim()).filter(Boolean).join('\n');
}

/** The current company's billing address as text ('' until loaded). */
export function useMyCompanyAddress(): string {
  const { data } = useMyCompany();
  return companyAddressBlock(data);
}
