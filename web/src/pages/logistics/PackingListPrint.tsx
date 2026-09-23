import { createPortal } from 'react-dom';
import { fmtNumber, fmtDecimal } from '../../lib/format';

/**
 * Printable packing list in the client's layout (packinglist.xlsx): export
 * header block, carton table (columns per type), block sub-totals, grand total,
 * Order / Shipped / Diff summary and the totals footer. Rendered from the
 * SAVED (server-computed) packing list.
 */

const dmy = (d?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};
const lines = (t?: string | null) => String(t ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function PackingListDocument({ pl }: { pl: any }) {
  const type: 'ASSORTED' | 'SOLID' | 'MIXED' = pl.pl_type || 'ASSORTED';
  const blocks: any[] = pl.blocks || [];
  const nSizes = Math.max(1, ...blocks.map((b) => (b.effective_size_headers || []).length));
  const T = pl.totals || {};
  const left = type === 'ASSORTED' ? ['ORDER NO', 'COLOUR'] : type === 'SOLID' ? ['ORDER NO', 'STYLE NAME', 'COLOUR'] : ['Order no', 'Style no', 'COLOUR'];
  const cell = 'border border-black px-1 py-0.5';
  const num = 'border border-black px-1 py-0.5 text-right tabular-nums';
  const pad = (arr: any[]) => [...arr, ...Array(Math.max(0, nSizes - arr.length)).fill('')];
  const rightCols = type === 'MIXED' ? 9 : 7;
  const totalCols = 3 + left.length + nSizes + rightCols;
  const summary = (pl.order_summary || []).filter((g: any) => g.order_source !== 'NONE' || type === 'ASSORTED');

  const subtotalCells = (b: any) => (
    <>
      {type === 'MIXED' ? <td className={cell} colSpan={3} /> : <td className={cell} />}
      <td className={num + ' font-semibold'}>{fmtNumber(b.total_cartons)}</td>
      <td className={num + ' font-semibold'}>{fmtNumber(b.total_qty)}</td>
      <td className={cell} colSpan={2} />
      <td className={num + ' font-semibold'}>{fmtDecimal(b.total_net_wt, 2)}</td>
      <td className={num + ' font-semibold'}>{fmtDecimal(b.total_gross_wt, 2)}</td>
    </>
  );
  const sizeHeaderRow = (b: any, label?: string | null, sub?: any) => (
    <tr className="bg-slate-50">
      <td className={cell + ' font-semibold'} colSpan={3 + left.length}>{label || ''}</td>
      {pad(b.effective_size_headers || []).map((h: string, i: number) => <td key={i} className={cell + ' text-center font-semibold'}>{h}</td>)}
      {sub ? subtotalCells(sub) : <td className={cell} colSpan={rightCols} />}
    </tr>
  );

  return (
    <div className="pl-doc bg-white text-[10px] leading-tight text-black">
      <table className="w-full border-collapse">
        <tbody>
          <tr><td colSpan={2} className={cell + ' text-center text-[14px] font-bold tracking-wide'}>PACKING LIST</td></tr>
          <tr>
            <td className={cell + ' w-1/2 align-top'}>
              <div className="font-semibold">Exporter</div>
              {lines(pl.exporter_details).map((l, i) => <div key={i} className={i === 0 ? 'font-bold' : ''}>{l}</div>)}
            </td>
            <td className={cell + ' align-top'}>
              <div className="font-semibold">Invoice No. &amp; Date</div>
              <div>{pl.invoice_no || pl.ci_invoice_no || ''}{pl.invoice_date ? `  DT: ${dmy(pl.invoice_date)}` : ''}</div>
              {(pl.buyer_order_no || pl.buyer_order_date) && <div>PO NO: {pl.buyer_order_no}{pl.buyer_order_date ? `  DT: ${dmy(pl.buyer_order_date)}` : ''}</div>}
              <div className="mt-1 font-semibold">Other Reference(s)</div>
              {lines(pl.other_references).map((l, i) => <div key={i}>{l}</div>)}
            </td>
          </tr>
          <tr>
            <td className={cell + ' align-top'}>
              <div className="font-semibold">Consignee</div>
              {lines(pl.consignee_details).map((l, i) => <div key={i}>{l}</div>)}
            </td>
            <td className={cell + ' align-top'}>
              <div className="font-semibold">{pl.notify_label || 'Notify Party :-'}</div>
              {lines(pl.notify_details).map((l, i) => <div key={i}>{l}</div>)}
              <div className="mt-1 grid grid-cols-2 gap-2">
                <div><div className="font-semibold">Country of origin of goods</div>{pl.country_of_origin || 'INDIA'}</div>
                <div><div className="font-semibold">Country of final destination</div>{pl.country_of_destination}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td className={cell + ' align-top p-0'}>
              <table className="w-full border-collapse">
                <tbody>
                  {[['Pre-carriage by', pl.pre_carriage_by, 'Place of receipt by pre-carrier', pl.place_of_receipt],
                    ['Vessel/Flight No.', pl.vessel_flight_no, 'Port of Loading', pl.port_of_loading],
                    ['Port of Discharge', pl.port_of_discharge, 'Final Destination', pl.final_destination]].map(([a, av, b, bv], i) => (
                    <tr key={i}>
                      <td className="w-1/2 border-b border-r border-black px-1 py-0.5 align-top"><div className="font-semibold">{a}</div>{av || ' '}</td>
                      <td className="border-b border-black px-1 py-0.5 align-top"><div className="font-semibold">{b}</div>{bv || ' '}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
            <td className={cell + ' align-top'}>
              <div className="font-semibold">Terms of Delivery and Payment</div>
              {lines(pl.terms_of_delivery).map((l, i) => <div key={`d${i}`}>{i === 0 && !/^DELIVERY/i.test(l) ? `DELIVERY: ${l}` : l}</div>)}
              {lines(pl.terms_of_payment).map((l, i) => <div key={`p${i}`}>{i === 0 && !/^PAYMENT/i.test(l) ? `PAYMENT TERMS: ${l}` : l}</div>)}
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mt-0 w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className={cell} colSpan={3} rowSpan={2}>CTN NO</th>
            {left.map((t) => <th key={t} className={cell} rowSpan={2}>{t}</th>)}
            <th className={cell} colSpan={nSizes}>{type === 'SOLID' ? 'QUANTITY / SIZE (PCS)' : 'SIZE (PCS)'}</th>
            {type === 'MIXED' ? <>
              <th className={cell} rowSpan={2}>PCS/ PACK</th>
              <th className={cell} colSpan={2}>PACK/ CTNS</th>
              <th className={cell} rowSpan={2}>TOT Ctns</th>
              <th className={cell} rowSpan={2}>Total Qty (PCS)</th>
            </> : <>
              <th className={cell} rowSpan={2}>PCS/ CTN</th>
              <th className={cell} rowSpan={2}>{type === 'SOLID' ? 'TOT CTNS' : 'TOTAL Ctns'}</th>
              <th className={cell} rowSpan={2}>{type === 'SOLID' ? 'TOT PCS' : 'Total Qty (PCS)'}</th>
            </>}
            <th className={cell} colSpan={2}>WEIGHT/CTN (KG)</th>
            <th className={cell} colSpan={2}>TOTAL WEIGHT (KG)</th>
          </tr>
          <tr className="bg-slate-100">
            {pad(blocks[0]?.effective_size_headers || []).map((h: string, i: number) => <th key={i} className={cell}>{h}</th>)}
            {type === 'MIXED' && <><th className={cell}>PCS</th><th className={cell}>PACKS</th></>}
            <th className={cell}>NETT</th><th className={cell}>GROSS</th><th className={cell}>NETT</th><th className={cell}>GROSS</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b, bi) => (
            <FragmentBlock key={bi}>
              {bi === 0 && b.label && (
                <tr><td className={cell + ' font-semibold'} colSpan={totalCols}>{b.label}</td></tr>
              )}
              {bi > 0 && sizeHeaderRow(b, b.label, blocks[bi - 1])}
              {(b.rows || []).map((r: any, ri: number) => (r.items || []).map((it: any, ii: number) => {
                const span = r.items.length;
                const heads = pad(b.effective_size_headers || []);
                return (
                  <tr key={`${ri}-${ii}`}>
                    {ii === 0 && <>
                      <td className={num} rowSpan={span}>{r.ctn_from}</td>
                      <td className={cell + ' text-center'} rowSpan={span}>-</td>
                      <td className={num} rowSpan={span}>{r.ctn_to}</td>
                    </>}
                    <td className={cell}>{it.order_no}</td>
                    {type !== 'ASSORTED' && <td className={cell}>{type === 'SOLID' ? (it.style_no || it.style_name) : [it.style_no, it.style_name].filter(Boolean).join(' - ')}</td>}
                    <td className={cell}>{it.colour}</td>
                    {heads.map((h: string, i: number) => <td key={i} className={num}>{h && it.size_qty?.[h] ? it.size_qty[h] : ''}</td>)}
                    {type === 'MIXED' && <td className={num}>{r.packs_per_ctn ? it.unit_qty : ''}</td>}
                    {ii === 0 && <>
                      {type === 'MIXED'
                        ? (r.packs_per_ctn
                          ? <><td className={num} rowSpan={span}>{r.pcs_per_pack}</td><td className={num} rowSpan={span}>{r.packs_per_ctn}</td></>
                          : <td className={num} rowSpan={span} colSpan={2}>{r.pcs_per_ctn}</td>)
                        : <td className={num} rowSpan={span}>{r.pcs_per_ctn}</td>}
                      <td className={num} rowSpan={span}>{r.no_of_ctns}</td>
                      <td className={num} rowSpan={span}>{fmtNumber(r.total_qty)}</td>
                      <td className={num} rowSpan={span}>{r.net_wt_per_ctn ?? ''}</td>
                      <td className={num} rowSpan={span}>{r.gross_wt_per_ctn ?? ''}</td>
                      <td className={num} rowSpan={span}>{fmtDecimal(r.total_net_wt, 2)}</td>
                      <td className={num} rowSpan={span}>{fmtDecimal(r.total_gross_wt, 2)}</td>
                    </>}
                  </tr>
                );
              }))}
              {bi === blocks.length - 1 && (
                <tr className="bg-slate-50">
                  <td className={cell} colSpan={3 + left.length + nSizes} />
                  {subtotalCells(b)}
                </tr>
              )}
            </FragmentBlock>
          ))}
          <tr className="bg-slate-200 font-bold">
            <td className={cell} colSpan={3 + left.length + nSizes}>GRAND TOTAL</td>
            {subtotalCells(T)}
          </tr>
        </tbody>
      </table>

      {summary.length > 0 && (
        <table className="mt-3 border-collapse">
          <tbody>
            {summary.map((g: any, gi: number) => (
              <FragmentBlock key={gi}>
                <tr className="bg-slate-100">
                  <td className={cell + ' font-semibold'}>{[g.style_no || g.style_name, g.colour].filter(Boolean).join(' / ')}</td>
                  {g.sizes.map((s: string) => <td key={s} className={cell + ' text-center font-semibold'}>{s}</td>)}
                  <td className={cell + ' font-semibold'}>TOTAL</td>
                </tr>
                {[['ORDER Qty', g.order, g.order_total], ['Shipped Qty', g.shipped, g.shipped_total], ['Diff', g.diff, g.diff_total]].map(([lbl, m, t]: any) => (
                  <tr key={lbl}>
                    <td className={cell}>{lbl}{lbl === 'ORDER Qty' && g.order_source === 'NONE' ? ' (not entered)' : ''}</td>
                    {g.sizes.map((s: string) => <td key={s} className={num}>{fmtNumber(m?.[s] ?? 0)}</td>)}
                    <td className={num + ' font-semibold'}>{fmtNumber(t)}</td>
                  </tr>
                ))}
              </FragmentBlock>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4 flex justify-between gap-6 text-[11px]">
        <table className="border-collapse">
          <tbody>
            <tr><td className="pr-3 font-semibold">TOTAL CARTONS</td><td>:</td><td className="px-2 text-right tabular-nums">{fmtNumber(T.total_cartons)}</td><td>CTNS</td></tr>
            <tr><td className="pr-3 font-semibold">TOTAL PIECES</td><td>:</td><td className="px-2 text-right tabular-nums">{fmtNumber(T.total_qty)}</td><td>PCS</td></tr>
            <tr><td className="pr-3 font-semibold">TOTAL NET WEIGHT</td><td>:</td><td className="px-2 text-right tabular-nums">{fmtDecimal(T.total_net_wt, 2)}</td><td>KGS</td></tr>
            <tr><td className="pr-3 font-semibold">TOTAL GROSS WEIGHT</td><td>:</td><td className="px-2 text-right tabular-nums">{fmtDecimal(T.total_gross_wt, 2)}</td><td>KGS</td></tr>
            <tr><td className="pr-3 font-semibold">CARTONS MEASUREMENT</td><td>:</td>
              <td className="px-2" colSpan={2}>{(pl.measurements || []).map((m: any) => `${m.dims} - CM - ${m.cartons} CTNS`).join(' / ') || '-'}</td></tr>
            <tr><td className="pr-3 font-semibold">CBM</td><td>:</td><td className="px-2 text-right tabular-nums">{fmtDecimal(T.total_cbm, 3)}</td><td>CBM</td></tr>
          </tbody>
        </table>
        <div className="flex flex-col justify-end text-right">
          <div className="font-semibold">for {lines(pl.exporter_details)[0] || ''}</div>
          <div className="mt-10">Signature &amp; Date</div>
        </div>
      </div>
    </div>
  );
}

function FragmentBlock({ children }: { children: React.ReactNode }) { return <>{children}</>; }

/**
 * Print-only copy mounted on <body>: the print stylesheet hides the whole app
 * (sidebar, header, editor) and shows only this document.
 */
export function PackingListPrintPortal({ pl }: { pl: any }) {
  return createPortal(
    <div id="pl-print-root">
      <style>{`
        #pl-print-root { display: none; }
        @media print {
          @page { size: A4 landscape; margin: 8mm; }
          body > *:not(#pl-print-root) { display: none !important; }
          #pl-print-root { display: block !important; }
          #pl-print-root .pl-doc { font-size: 9px; }
          #pl-print-root tr { break-inside: avoid; }
          #pl-print-root .bg-slate-50, #pl-print-root .bg-slate-100, #pl-print-root .bg-slate-200 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <PackingListDocument pl={pl} />
    </div>,
    document.body,
  );
}
