import { Fragment } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { http } from '../../lib/api';
import { PageHeader, LoadingBlock, ErrorState } from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber, humanize } from '../../lib/format';

/**
 * Printable Bill of Materials (server: GET /boms/:id/print). Lines are grouped
 * by material type and carry the Specification typed next to the material
 * (poly bag measurement, care label wording …). Required qty is worked on the
 * order's plan-cut quantity (order + excess) for the colours / sizes each line
 * applies to; a master BOM without a sales order prints consumption only.
 */

const TYPE_ORDER = ['FABRIC', 'YARN', 'TRIM', 'ACCESSORY', 'PACKING', 'GENERAL'];
const TYPE_LABEL: Record<string, string> = {
  FABRIC: 'Fabric', YARN: 'Yarn', TRIM: 'Trims', ACCESSORY: 'Accessories', PACKING: 'Packing', GENERAL: 'General',
};
const BASIS_LABEL: Record<string, string> = {
  PER_PIECE: 'Per pc', PER_DOZEN: 'Per dozen', PER_CARTON: 'Per carton', PER_SET: 'Per set', FIXED_QTY: 'Fixed',
};

const cleanMaterialName = (val: any) => {
  if (!val) return '';
  return String(val)
    .replace(/\s*\([A-Za-z0-9_-]+\)$/, '')
    .replace(/\s*\[[A-Za-z0-9_-]+\]$/, '')
    .replace(/^[A-Za-z0-9_-]+\s*[-—:]\s*/, '')
    .trim();
};

const materialName = (l: any) => {
  const raw = l.material_type === 'YARN' ? (l.yarn_name || l.item_description)
    : l.material_type === 'FABRIC' ? (l.fabric_name || l.item_description)
    : ([l.trim_name, l.trim_name && l.item_description && l.item_description !== l.trim_name ? l.item_description : null]
        .filter(Boolean).join(' — ') || l.item_description);
  return cleanMaterialName(raw);
};

export function BomDocument({ d }: { d: any }) {
  const b = d.bom || {};
  const co = d.company || {};
  const lines: any[] = d.lines || [];
  const hasQty = d.plan_cut_qty !== null && d.plan_cut_qty !== undefined;
  const groups = [
    ...TYPE_ORDER.filter((t) => lines.some((l) => l.material_type === t)),
    ...[...new Set(lines.map((l) => l.material_type))].filter((t) => !TYPE_ORDER.includes(t)),
  ].map((t) => [t, lines.filter((l) => l.material_type === t)] as const);
  const cell = 'border border-black px-1.5 py-1 align-top';
  const num = cell + ' text-right tabular-nums';
  const cols = hasQty ? 10 : 9;
  const address = [co.address_line1, co.address_line2, co.city, co.state, co.pincode].filter(Boolean).join(', ');

  return (
    <div className="bom-doc bg-white text-[11px] leading-snug text-black">
      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td colSpan={4} className={cell + ' text-center'}>
              <div className="text-[15px] font-bold uppercase tracking-wide">{co.trade_name || co.legal_name}</div>
              {address && <div className="text-[10px]">{address}</div>}
              <div className="mt-1 text-[13px] font-bold tracking-wider">BILL OF MATERIALS</div>
            </td>
          </tr>
          <tr>
            <td className={cell + ' w-1/4'}><span className="font-semibold">BOM No:</span> {b.bom_no} (v{b.version})</td>
            <td className={cell + ' w-1/4'}><span className="font-semibold">Effective:</span> {fmtDate(b.effective_date)}</td>
            <td className={cell + ' w-1/4'}><span className="font-semibold">Status:</span> {humanize(b.approval_state || b.status_label || '')}</td>
            <td className={cell + ' w-1/4'}><span className="font-semibold">Buyer:</span> {b.buyer_name || '—'}</td>
          </tr>
          <tr>
            <td className={cell}><span className="font-semibold">Style:</span> {b.style_code}{b.style_name ? ` — ${b.style_name}` : ''}</td>
            <td className={cell}><span className="font-semibold">SO No:</span> {b.so_no || 'Master (all orders)'}</td>
            <td className={cell}><span className="font-semibold">IO No:</span> {b.io_no || '—'}{b.buyer_po_no ? ` / PO: ${b.buyer_po_no}` : ''}</td>
            <td className={cell}>
              <span className="font-semibold">Order Qty:</span> {hasQty ? fmtNumber(d.order_qty) : '—'}
              {hasQty && <> &nbsp;<span className="font-semibold">Plan Cut:</span> {fmtNumber(d.plan_cut_qty)}</>}
            </td>
          </tr>
        </tbody>
      </table>

      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="bg-slate-100">
            <th className={cell + ' w-8'}>#</th>
            <th className={cell}>Material</th>
            <th className={cell}>Specification</th>
            <th className={cell}>Colour</th>
            <th className={cell}>Size</th>
            <th className={cell}>Basis</th>
            <th className={cell + ' text-right'}>Cons/pc</th>
            <th className={cell}>UOM</th>
            <th className={cell + ' text-right'}>Waste %</th>
            {hasQty && <th className={cell + ' text-right'}>Required Qty</th>}
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr><td className={cell + ' text-center text-slate-500'} colSpan={cols}>No components on this BOM.</td></tr>
          )}
          {groups.map(([type, rows]) => (
            <Fragment key={type}>
              <tr className="bg-slate-50">
                <td className={cell + ' font-bold uppercase'} colSpan={cols}>{TYPE_LABEL[type] ?? humanize(type)}</td>
              </tr>
              {rows.map((l, i) => (
                <tr key={l.id}>
                  <td className={num}>{i + 1}</td>
                  <td className={cell}>{materialName(l) || '—'}</td>
                  <td className={cell + ' whitespace-pre-wrap'}>
                    {[
                      l.specification,
                      // Fabric: Dia / GSM · Yarn: count · Grey / Dyed (+ colour)
                      l.material_type === 'FABRIC' && (l.dia || l.gsm) ? [l.dia ? `${String(l.dia).replace(/"$/, '')}" Dia` : '', l.gsm ? `${l.gsm} GSM` : ''].filter(Boolean).join(' · ') : '',
                      l.material_type === 'YARN' && l.yarn_count_value ? `Count ${l.yarn_count_value}${l.yarn_count_type && l.yarn_count_type !== 'Ne' ? ` ${l.yarn_count_type}` : ''}` : '',
                      l.dye_type ? (l.dye_type === 'DYED' ? `Dyed${l.material_color_name ? ` — ${l.material_color_name}` : ''}` : 'Cora / Raw') : '',
                    ].filter(Boolean).join('\n')}
                  </td>
                  <td className={cell}>{l.color_name || 'All'}</td>
                  <td className={cell}>{l.size_code || 'All'}</td>
                  <td className={cell}>{BASIS_LABEL[l.consumption_basis] ?? humanize(l.consumption_basis || 'PER_PIECE')}</td>
                  <td className={num}>{fmtDecimal(l.consumption, 4)}</td>
                  <td className={cell}>{l.uom_code || ''}</td>
                  <td className={num}>{fmtDecimal(l.wastage_pct, 2)}</td>
                  {hasQty && (
                    <td className={num}>
                      {l.required_qty === null || l.required_qty === undefined ? '—' : fmtDecimal(l.required_qty, 3)}
                    </td>
                  )}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>

      {b.remarks && (
        <div className="mt-2"><span className="font-semibold">Remarks:</span> {b.remarks}</div>
      )}
      {hasQty && (
        <div className="mt-1 text-[9.5px] text-slate-600">
          Required Qty = plan-cut qty of the applicable colour / size × consumption (per dozen ÷ 12; fixed = as entered)
          × (1 + waste %) + additional qty.
        </div>
      )}

      <div className="mt-8 grid grid-cols-3 gap-6 text-center text-[11px]">
        <div><div className="min-h-[1.25rem]">{b.created_by_name || ''}</div><div className="border-t border-black pt-1 font-semibold">Prepared by</div></div>
        <div><div className="min-h-[1.25rem]" /><div className="border-t border-black pt-1 font-semibold">Checked by</div></div>
        <div><div className="min-h-[1.25rem]">{b.approved_by_name || ''}</div><div className="border-t border-black pt-1 font-semibold">Approved by</div></div>
      </div>
    </div>
  );
}

/** Print-only copy mounted on <body>; the print stylesheet hides the app shell. */
function BomPrintPortal({ d }: { d: any }) {
  return createPortal(
    <div id="bom-print-root">
      <style>{`
        #bom-print-root { display: none; }
        @media print {
          @page { size: A4 portrait; margin: 8mm; }
          body > *:not(#bom-print-root) { display: none !important; }
          #bom-print-root { display: block !important; }
          #bom-print-root .bom-doc { font-size: 9.5px; }
          #bom-print-root tr { break-inside: avoid; }
          #bom-print-root .bg-slate-50, #bom-print-root .bg-slate-100 { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <BomDocument d={d} />
    </div>,
    document.body,
  );
}

export default function BomPrintPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useQuery({
    queryKey: ['boms', 'print', id],
    queryFn: async () => (await http.get<{ data: any }>(`/boms/${id}/print`)).data,
    enabled: !!id,
  });

  return (
    <>
      <PageHeader
        breadcrumb={['Master Data', 'Bill of Materials', 'Print']}
        title={q.data ? `BOM ${q.data.bom?.bom_no ?? ''} (v${q.data.bom?.version ?? 1})` : 'BOM Print'}
        subtitle="Print preview"
        actions={<>
          <button className="btn-secondary" onClick={() => nav(`/masters/boms/${id}`)}>
            <ArrowLeft size={15} /> Back to BOM
          </button>
          <button className="btn-primary" onClick={() => window.print()} disabled={!q.data}>
            <Printer size={15} /> Print
          </button>
        </>} />
      {q.isLoading && <div className="card"><LoadingBlock rows={8} /></div>}
      {q.error && <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>}
      {q.data && (
        <>
          <div className="card overflow-x-auto p-6"><BomDocument d={q.data} /></div>
          <BomPrintPortal d={q.data} />
        </>
      )}
    </>
  );
}
