/**
 * The printed commercial invoice (client voice note 23-Oct-2026: "make the printout neat — Tally layout or a
 * professional look"). Same boxes and order as the FK-087 sheet, drawn as an A4 document: ruled boxes with small
 * captions, the item table in the shipping bill pattern with a shaded header that repeats on every page, totals and
 * amount in words, the GST endorsement, bank + REX (buyer copy) or FOB / IGST working (IGST copy), the e-way bill made
 * from the invoice with its QR code, the declaration and the signatory. The Excel keeps the FK-087 cell grid.
 */
import type { ReactNode } from 'react';

const lines = (t: unknown) => String(t ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
const dmy = (d: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const num = (v: unknown, dp: number, inr = false) => {
  const x = Number(v);
  if (v == null || v === '' || Number.isNaN(x)) return '';
  return x.toLocaleString(inr ? 'en-IN' : 'en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

const CSS = `
.cinv { font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; font-size: 10.5px; line-height: 1.35; color: #111; background: #fff; }
.cinv * { box-sizing: border-box; }
.cinv .sheet { border: 1.2px solid #111; }
.cinv .title { display: flex; align-items: stretch; border-bottom: 1.2px solid #111; }
.cinv .title h1 { flex: 1; margin: 0; padding: 7px 0 6px; text-align: center; font-size: 16px; letter-spacing: 3px; font-weight: 700; }
.cinv .title .copy { align-self: center; padding: 0 8px; font-size: 9px; color: #444; white-space: nowrap; }
.cinv .row { display: grid; border-bottom: 1px solid #111; }
.cinv .row:last-child { border-bottom: 0; }
.cinv .cell { padding: 3px 6px 4px; min-width: 0; }
.cinv .cell + .cell { border-left: 1px solid #111; }
.cinv .stack > .cell + .cell { border-left: 0; border-top: 1px solid #111; }
.cinv .cap { display: block; font-size: 8.5px; color: #444; text-transform: none; margin-bottom: 1px; }
.cinv .v { font-weight: 700; white-space: pre-line; overflow-wrap: anywhere; }
.cinv .addr { white-space: pre-line; overflow-wrap: anywhere; }
.cinv .addr .first { font-weight: 700; font-size: 11.5px; }
.cinv .stack { display: grid; }
.cinv table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
.cinv table.items th { background: #e9edf2; font-size: 9px; font-weight: 700; text-align: center; padding: 4px 3px; border: 1px solid #111; border-top: 0; vertical-align: middle; }
.cinv table.items th:first-child, .cinv table.items td:first-child { border-left: 0; }
.cinv table.items th:last-child, .cinv table.items td:last-child { border-right: 0; }
.cinv table.items td { padding: 3px 4px; border-left: 1px solid #111; border-right: 1px solid #111; vertical-align: top; overflow-wrap: anywhere; }
.cinv table.items tbody tr + tr td { border-top: 1px dotted #b5bcc6; }
.cinv table.items tr.filler td { height: 40px; border-top: 0 !important; }
.cinv table.items tfoot td { border-top: 1px solid #111; font-weight: 700; padding: 4px; }
.cinv thead { display: table-header-group; }
.cinv tr { page-break-inside: avoid; break-inside: avoid; }
.cinv .c { text-align: center; } .cinv .r { text-align: right; font-variant-numeric: tabular-nums; }
.cinv .b { font-weight: 700; }
.cinv .words { padding: 4px 6px; border-bottom: 1px solid #111; }
.cinv .endorse { padding: 5px 6px; text-align: center; font-weight: 700; border-bottom: 1px solid #111; letter-spacing: .2px; }
.cinv .kv { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; row-gap: 1px; }
.cinv .kv span:nth-child(odd) { color: #333; }
.cinv .kv span:nth-child(even) { font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.cinv table.mini { width: 100%; border-collapse: collapse; }
.cinv table.mini th, .cinv table.mini td { border: 1px solid #9aa3ae; padding: 2px 4px; font-size: 9.5px; }
.cinv table.mini th { background: #f1f4f7; font-weight: 700; }
.cinv .ewb { display: flex; gap: 8px; align-items: center; }
.cinv .ewb img { width: 78px; height: 78px; image-rendering: pixelated; }
.cinv .sign { display: flex; flex-direction: column; justify-content: space-between; min-height: 92px; text-align: right; }
.cinv .decl { font-size: 9.5px; }
@media print { .cinv { font-size: 9.5px; } .cinv .addr .first { font-size: 10.5px; } }
`;

export function InvoiceDocument({ d, format }: { d: any; format: 'BUYER' | 'IGST' }) {
  const igst = format === 'IGST';
  const cur = d.currency_code || '';
  const T = d.totals ?? {};
  const goods = (d.lines ?? []).filter((l: any) => l.line_kind !== 'CHARGE');
  const charges = (d.lines ?? []).filter((l: any) => l.line_kind === 'CHARGE');
  const exporter = lines(d.exporter_details);
  const ewb = d.eway_bill?.generated ? d.eway_bill : null;
  const unit = d.qty_unit || 'PCS';
  const terms = [...lines(d.terms_of_delivery), ...lines(d.terms_of_payment)];
  const Addr = ({ t }: { t: unknown }) => {
    const ls = lines(t);
    return <div className="addr">{ls.map((l, i) => <div key={i} className={i === 0 ? 'first' : undefined}>{l}</div>)}</div>;
  };
  const Box = ({ cap, children, className }: { cap: string; children?: ReactNode; className?: string }) => (
    <div className={`cell ${className ?? ''}`}><span className="cap">{cap}</span>{children}</div>
  );
  let sno = 0;
  return (
    <div className="cinv" data-testid="ci-document">
      <style>{CSS}</style>
      <div className="sheet">
        <div className="title">
          <span className="copy" style={{ visibility: 'hidden' }}>{igst ? 'IGST INVOICE' : 'BUYER INVOICE'}</span>
          <h1>COMMERCIAL INVOICE</h1>
          <span className="copy">{igst ? 'IGST INVOICE' : 'BUYER INVOICE'}</span>
        </div>

        {/* exporter | invoice no & date · exporter's ref · buyer's order · other refs */}
        <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Box cap="Exporter"><Addr t={d.exporter_details} /></Box>
          <div className="cell stack" style={{ padding: 0 }}>
            <div className="row" style={{ gridTemplateColumns: '1.15fr 1fr', borderBottom: '1px solid #111' }}>
              <Box cap="Invoice No. & Date"><span className="v">{d.invoice_no}{d.invoice_date ? `  DT: ${dmy(d.invoice_date)}` : ''}</span></Box>
              <Box cap="Exporter's Ref."><span className="v">{lines(d.exporter_ref).join('\n')}</span></Box>
            </div>
            <Box cap="Buyer's Order No. & Date"><span className="v">{lines(d.buyer_order_ref).join('  /  ')}</span></Box>
            <Box cap="Other Reference(s)"><span className="v">{lines(d.other_references).join('\n')}</span></Box>
          </div>
        </div>

        {/* consignee | buyer + countries */}
        <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Box cap="Consignee"><Addr t={d.consignee_details} /></Box>
          <div className="cell stack" style={{ padding: 0 }}>
            <Box cap="Buyer (if other than consignee)"><Addr t={d.buyer_details} /></Box>
            <div className="row" style={{ gridTemplateColumns: '1fr 1fr', borderBottom: 0, borderTop: '1px solid #111' }}>
              <Box cap="Country of Origin of Goods" className="c"><span className="v">{d.country_origin_text}</span></Box>
              <Box cap="Country of Final Destination" className="c"><span className="v">{d.country_dest_text}</span></Box>
            </div>
          </div>
        </div>

        {/* shipment | terms (+ e-way bill) */}
        <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="cell" style={{ padding: 0 }}>
            {[['Pre-Carriage by', d.pre_carriage_by, 'Place of Receipt by Pre-carrier', d.place_of_receipt],
              ['Vessel / Flight No.', d.vessel_flight_no, 'Port of Loading', d.port_of_loading],
              ['Port of Discharge', d.port_of_discharge, 'Final Destination', d.final_destination]].map(([a, av, b, bv], i) => (
              <div key={i} className="row" style={{ gridTemplateColumns: '1fr 1fr', borderBottom: i < 2 ? '1px solid #111' : 0 }}>
                <Box cap={a}><span className="v">{av}</span></Box><Box cap={b}><span className="v">{bv}</span></Box>
              </div>))}
          </div>
          <div className="cell" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><span className="cap">Terms of Delivery and Payment</span><span className="v">{terms.join('\n')}</span></div>
            {ewb && (
              <div className="ewb" id="ci-doc-ewb" style={{ marginTop: 'auto' }}>
                {ewb.qr && <img src={ewb.qr} alt={`E-way bill ${ewb.ewb_no}`} />}
                <div><span className="cap">E-Way Bill</span>
                  <div className="b" style={{ fontSize: 12.5, letterSpacing: 0.5 }}>{ewb.ewb_no}</div>
                  <div>Dt: {ewb.ewb_date}</div>
                  {ewb.valid_upto && <div>Valid upto: {ewb.valid_upto}</div>}
                  {ewb.vehicle_no && <div>Vehicle: {ewb.vehicle_no}</div>}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* marks | packages | description heading */}
        <div className="row" style={{ gridTemplateColumns: '1.1fr 0.9fr 2fr' }}>
          <Box cap="Marks & Nos. / Container No."><span className="addr">{lines(d.marks_nos).join('\n')}</span></Box>
          <Box cap="No. & Kind of Pkgs."><span className="v">{lines(d.packages_text).join('\n')}</span></Box>
          <Box cap="Description of Goods"><span className="v">{lines(d.goods_heading).join('\n')}</span></Box>
        </div>

        {/* items — the shipping bill item pattern + colour / size, order no + style/ref per line */}
        <table className="items">
          <colgroup>{[4, 10, 9, 8, 24, 9, 10, 7, 5, 6.5, 7.5].map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}</colgroup>
          <thead><tr>
            <th>S.No</th><th>Order No.</th><th>Style / Ref No.</th><th>HS Code</th><th>Description of Goods</th><th>Colour</th><th>Size</th>
            <th>Quantity</th><th>UQC</th><th>Rate<br />({d.rate_basis || cur})</th><th>Value<br />({cur})</th>
          </tr></thead>
          <tbody>
            {[...goods, ...charges].map((l: any, i: number) => (
              <tr key={i}>
                <td className="c">{++sno}</td>
                <td>{l.line_kind === 'CHARGE' ? '' : l.order_no}</td>
                <td>{l.line_kind === 'CHARGE' ? '' : (l.style_ref ?? l.supplier_mat_no)}</td>
                <td className="c">{l.hsn_code}</td>
                <td style={{ whiteSpace: 'pre-line' }}>{l.description}</td>
                <td>{l.line_kind === 'CHARGE' ? '' : l.colour}</td>
                <td className="c">{l.line_kind === 'CHARGE' ? '' : l.size_text}</td>
                <td className="r">{num(l.qty, 0)}</td>
                <td className="c">{l.uqc || unit}</td>
                <td className="r">{num(l.unit_price, 2)}</td>
                <td className="r">{num(l.amount, 2)}</td>
              </tr>
            ))}
            <tr className="filler">{Array.from({ length: 11 }, (_, i) => <td key={i} />)}</tr>
          </tbody>
          <tfoot><tr>
            <td colSpan={7} className="r">TOTAL</td><td className="r">{num(T.goods_qty, 0)}</td><td className="c">{unit}</td><td />
            <td className="r" id="ci-doc-total">{num(T.total_amount, 2)}</td>
          </tr></tfoot>
        </table>

        {/* packing summary | ship to | amount */}
        <div className="row" style={{ gridTemplateColumns: '1fr 1.2fr 0.9fr', borderTop: '1px solid #111' }}>
          <div className="cell kv">
            <span>Total Cartons</span><span>{d.total_cartons != null ? `${num(d.total_cartons, 0)} CTNS` : '—'}</span>
            <span>Total Pcs</span><span>{d.total_pcs != null ? `${num(d.total_pcs, 0)} ${d.total_pcs_unit || unit}` : '—'}</span>
            <span>Net Weight</span><span>{d.net_weight_kg != null ? `${num(d.net_weight_kg, 3)} KGS` : '—'}</span>
            <span>Gross Weight</span><span>{d.gross_weight_kg != null ? `${num(d.gross_weight_kg, 3)} KGS` : '—'}</span>
          </div>
          <Box cap="Ship To (Delivery Address)"><Addr t={d.ship_to_details} /></Box>
          <div className="cell kv" style={{ alignContent: 'start' }}>
            <span>Goods ({cur})</span><span>{num(T.goods_amount, 2)}</span>
            {charges.length > 0 && <><span>Charges ({cur})</span><span>{num(T.charges_amount, 2)}</span></>}
            <span className="b" style={{ color: '#111' }}>Total ({cur})</span><span style={{ fontSize: 12 }}>{num(T.total_amount, 2)}</span>
          </div>
        </div>
        <div className="words"><span className="cap">Total Quantity (in words)</span><span className="v">{d.words?.qty}</span></div>
        <div className="words"><span className="cap">Amount Chargeable (in words)</span><span className="v">{d.words?.amount}</span></div>
        {d.gst_endorsement && <div className="endorse">{d.gst_endorsement}</div>}

        {igst ? (
          <div className="row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="cell">
              <span className="cap">FOB / IGST working</span>
              <table className="mini">
                <thead><tr><th /><th className="r">Goods</th>{charges.length > 0 && <th className="r">Charges</th>}</tr></thead>
                <tbody>
                  <tr><td>FOB ({cur})</td><td className="r">{num(T.goods_amount, 2)}</td>{charges.length > 0 && <td className="r">{num(T.charges_amount, 2)}</td>}</tr>
                  <tr><td>Exchange rate (₹)</td><td className="r">{num(d.exchange_rate, 4, true)}</td>{charges.length > 0 && <td className="r">{num(d.exchange_rate, 4, true)}</td>}</tr>
                  <tr><td>FOB value (₹)</td><td className="r">{num(T.goods_inr, 2, true)}</td>{charges.length > 0 && <td className="r">{num(T.charges_inr, 2, true)}</td>}</tr>
                  <tr><td className="b">IGST paid (₹)</td><td className="r b">{num(T.goods_gst, 2, true)} <span style={{ fontWeight: 400 }}>@{num(d.goods_gst_rate, 0)}%</span></td>
                    {charges.length > 0 && <td className="r b">{num(T.charges_gst, 2, true)} <span style={{ fontWeight: 400 }}>@{num(d.charges_gst_rate, 0)}%</span></td>}</tr>
                </tbody>
              </table>
              {lines(d.footer_note).length > 0 && <p className="b" style={{ margin: '4px 0 0' }}>{lines(d.footer_note).join(' ')}</p>}
            </div>
            <div className="cell">
              <span className="cap">HSN-wise summary</span>
              <table className="mini">
                <thead><tr><th>HSN</th><th className="r">Qty</th><th className="r">Taxable ₹</th><th className="r">IGST %</th><th className="r">IGST ₹</th></tr></thead>
                <tbody>{(d.hsn_summary ?? []).map((h: any) => (
                  <tr key={`${h.hsn_code}-${h.gst_rate}`}><td>{h.hsn_code}</td><td className="r">{num(h.qty, 0)}</td><td className="r">{num(h.value_inr, 2, true)}</td>
                    <td className="r">{num(h.gst_rate, 0)}</td><td className="r">{num(h.gst_inr, 2, true)}</td></tr>))}</tbody>
              </table>
            </div>
          </div>
        ) : (lines(d.bank_details).length > 0 || lines(d.rex_declaration).length > 0) && (
          <div className="row" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
            <Box cap="Our Bank Details"><Addr t={d.bank_details} /></Box>
            <Box cap="REX Declaration"><span className="addr" style={{ fontSize: 9.5 }}>{lines(d.rex_declaration).join('\n')}</span></Box>
          </div>
        )}

        <div className="row" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
          <Box cap="Declaration" className="decl"><span className="addr b">{lines(d.declaration).join('\n')}</span></Box>
          <div className="cell sign">
            <span className="cap" style={{ textAlign: 'right' }}>Signature & Date</span>
            {exporter[0] && <span className="b">for {exporter[0]}</span>}
            <span className="b" style={{ marginTop: 34 }}>Authorised Signatory</span>
          </div>
        </div>
      </div>
    </div>
  );
}
