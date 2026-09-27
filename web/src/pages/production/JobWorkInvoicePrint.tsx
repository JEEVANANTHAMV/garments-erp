import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { Button, Modal } from '../../components/ui';

/**
 * Printable Job Work Invoice. The header carries the billing DIVISION name
 * ("CK Exports - Printing Division") with the company GSTIN / address unless
 * the division overrides them (server: GET /jobwork-invoices/:id/print).
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}
/** Indian grouping: crore / lakh / thousand. */
function inWords(amount: number): string {
  const rupees = Math.floor(amount), paise = Math.round((amount - rupees) * 100);
  const parts: string[] = [];
  let n = rupees;
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  const words = parts.join(' ') || 'Zero';
  return `Rupees ${words}${paise ? ` and ${below1000(paise)} Paise` : ''} Only`;
}

export function JobWorkInvoiceDocument({ d }: { d: any }) {
  const inv = d.invoice || {};
  const is = d.issuer || {};
  const p = d.party || {};
  const jw = d.jobwork || {};
  const T = d.totals || {};
  const cell = 'border border-black px-1.5 py-1';
  const num = cell + ' text-right tabular-nums';
  return (
    <div className="jwi-doc bg-white text-[11px] leading-snug text-black">
      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td colSpan={2} className={cell + ' text-center'}>
              <div className="text-[16px] font-bold uppercase tracking-wide">{is.billing_name}</div>
              {is.division_name && is.company_name && <div className="text-[10px]">(A division of {is.company_name})</div>}
              {is.address && <div>{is.address}</div>}
              <div>
                {is.gstin && <span className="font-semibold">GSTIN: {is.gstin}</span>}
                {is.phone && <span>{is.gstin ? '  |  ' : ''}Ph: {is.phone}</span>}
                {is.email && <span>  |  {is.email}</span>}
              </div>
            </td>
          </tr>
          <tr><td colSpan={2} className={cell + ' text-center text-[13px] font-bold tracking-wide'}>JOB WORK INVOICE</td></tr>
          <tr>
            <td className={cell + ' w-1/2 align-top'}>
              <div className="font-semibold">Billed to</div>
              <div className="font-bold">{p.name}</div>
              {p.address && <div>{p.address}</div>}
              {p.gstin && <div>GSTIN: {p.gstin}</div>}
              {p.state && <div>State: {p.state}</div>}
            </td>
            <td className={cell + ' align-top'}>
              <div className="grid grid-cols-[110px_1fr] gap-x-2">
                <span className="font-semibold">Invoice no</span><span>{inv.invoice_no}</span>
                <span className="font-semibold">Invoice date</span><span>{fmtDate(inv.invoice_date)}</span>
                <span className="font-semibold">Job Work In</span><span>{jw.jwin_no || '-'}{jw.jwin_date ? `  dt ${fmtDate(jw.jwin_date)}` : ''}</span>
                <span className="font-semibold">Customer DC</span><span>{jw.customer_dc_no || '-'}</span>
                <span className="font-semibold">Customer PO</span><span>{jw.customer_po_ref || '-'}</span>
                <span className="font-semibold">Process</span><span>{jw.process_type || '-'}</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className={cell + ' w-8'}>#</th>
            <th className={cell + ' text-left'}>Description</th>
            <th className={cell}>Customer DC</th>
            <th className={cell}>HSN/SAC</th>
            <th className={cell + ' text-right'}>Qty</th>
            <th className={cell + ' text-right'}>Rate</th>
            <th className={cell + ' text-right'}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {(d.lines || []).map((l: any, i: number) => (
            <tr key={i}>
              <td className={cell + ' text-center'}>{i + 1}</td>
              <td className={cell}>{l.description}</td>
              <td className={cell + ' text-center'}>{l.customer_dc_no || ''}</td>
              <td className={cell + ' text-center'}>{l.hsn_code || ''}</td>
              <td className={num}>{fmtNumber(l.qty)}</td>
              <td className={num}>{fmtDecimal(l.rate, 2)}</td>
              <td className={num}>{fmtDecimal(l.amount, 2)}</td>
            </tr>
          ))}
          <tr><td colSpan={6} className={num + ' font-semibold'}>Taxable value</td><td className={num + ' font-semibold'}>{fmtDecimal(T.taxable_amount, 2)}</td></tr>
          {T.inter_state ? (
            <tr><td colSpan={6} className={num}>IGST @ {fmtDecimal(T.gst_pct, 2)}%</td><td className={num}>{fmtDecimal(T.igst, 2)}</td></tr>
          ) : (
            <>
              <tr><td colSpan={6} className={num}>CGST @ {fmtDecimal(T.gst_pct / 2, 2)}%</td><td className={num}>{fmtDecimal(T.cgst, 2)}</td></tr>
              <tr><td colSpan={6} className={num}>SGST @ {fmtDecimal(T.gst_pct / 2, 2)}%</td><td className={num}>{fmtDecimal(T.sgst, 2)}</td></tr>
            </>
          )}
          <tr className="bg-slate-100">
            <td colSpan={6} className={num + ' text-[12px] font-bold'}>Invoice total {inv.currency_code ? `(${inv.currency_code})` : ''}</td>
            <td className={num + ' text-[12px] font-bold'}>{fmtDecimal(T.total_amount, 2)}</td>
          </tr>
          <tr><td colSpan={7} className={cell}><span className="font-semibold">Amount in words: </span>{inWords(Number(T.total_amount || 0))}</td></tr>
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse">
        <tbody>
          <tr>
            <td className={cell + ' w-1/2 align-top'}>
              {is.bank && (
                <>
                  <div className="font-semibold">Bank details</div>
                  {is.bank.bank_name && <div>{is.bank.bank_name}{is.bank.branch ? `, ${is.bank.branch}` : ''}</div>}
                  {is.bank.account_no && <div>A/c no: {is.bank.account_no}</div>}
                  {is.bank.ifsc && <div>IFSC: {is.bank.ifsc}</div>}
                </>
              )}
              {inv.remarks && <div className="mt-1"><span className="font-semibold">Remarks: </span>{inv.remarks}</div>}
            </td>
            <td className={cell + ' h-20 text-right align-top'}>
              <div className="font-semibold">For {is.billing_name}</div>
              <div className="mt-10">Authorised Signatory</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function JobWorkInvoicePrintPortal({ d }: { d: any }) {
  return createPortal(
    <div id="jwi-print-root">
      <style>{`
        #jwi-print-root { display: none; }
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          body > *:not(#jwi-print-root) { display: none !important; }
          #jwi-print-root { display: block !important; }
          #jwi-print-root .bg-slate-100 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <JobWorkInvoiceDocument d={d} />
    </div>,
    document.body,
  );
}

/** Print preview modal for one Job Work Invoice. */
export function JobWorkInvoicePrintModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['jobwork-invoice-print', id],
    queryFn: () => http.get<{ data: any }>(`/jobwork-invoices/${id}/print`).then((r) => r.data),
    enabled: !!id,
  });
  return (
    <Modal open={!!id} onClose={onClose} title="Job work invoice — print view" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => window.print()} disabled={!q.data}>Print</Button></>}>
      {q.isLoading && <div className="p-6 text-sm text-slate-500">Loading…</div>}
      {q.error && <div className="p-6 text-sm text-red-600">{(q.error as Error).message}</div>}
      {q.data && <JobWorkInvoiceDocument d={q.data} />}
      {q.data && <JobWorkInvoicePrintPortal d={q.data} />}
    </Modal>
  );
}
