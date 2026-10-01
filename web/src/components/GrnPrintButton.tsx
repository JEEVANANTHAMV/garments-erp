import { Printer } from 'lucide-react';
import { http } from '../lib/api';
import { barcodeHtml } from '../lib/printBarcode';
import { fmtDate } from '../lib/format';

/** Print a yarn / fabric / trim GRN (inward document) with its number as a barcode. */
export function GrnPrintButton({ kind, id }: { kind: 'grn' | 'trim'; id: number }) {
  const print = async () => {
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) return;
    const g = (await http.get<{ data: any }>(`/grn-print/${kind}/${id}`)).data;
    const e = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const c = g.company ?? {};
    const q = (v: unknown) => Number(v ?? 0).toFixed(3);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${e(g.grn_no)}</title><style>
      body{font:12px Arial;margin:22px}h1{font-size:17px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{border:1px solid #888;padding:4px 6px}th{background:#eee}
      .r{text-align:right}.meta td{border:none;padding:2px 6px}.sign{display:flex;justify-content:space-between;margin-top:48px}.sign div{border-top:1px solid #000;width:30%;text-align:center;padding-top:4px}</style></head><body>
      ${barcodeHtml(g.grn_no, 'Goods received note')}<div><b>${e(c.legal_name || c.trade_name || '')}</b><br/>${e([c.address_line1, c.city, c.state].filter(Boolean).join(', '))}${c.gstin ? ` · GSTIN ${e(c.gstin)}` : ''}</div>
      <h1 style="margin-top:8px">GOODS RECEIPT NOTE (INWARD)</h1>
      <table class="meta"><tr><td><b>GRN No:</b> ${e(g.grn_no)}</td><td><b>Date:</b> ${e(fmtDate(g.grn_date))}</td><td><b>Store:</b> ${e(g.warehouse_name ?? '')}</td></tr>
      <tr><td><b>Supplier:</b> ${e(g.supplier ?? '')}</td><td><b>PO:</b> ${e(g.po_nos || '—')}</td><td><b>Job / IO:</b> ${e(g.io_no || '—')}</td></tr>
      <tr><td><b>Supplier DC:</b> ${e(g.supplier_dc_no || '—')}</td><td><b>Supplier invoice:</b> ${e(g.supplier_inv_no || '—')}</td><td><b>Gate entry:</b> ${e(g.gate_entry_no || '—')} · <b>Vehicle:</b> ${e(g.vehicle_no || '—')}</td></tr></table>
      <table><thead><tr><th>#</th><th>Item</th><th>Colour</th><th>Lot</th><th class="r">Rolls / bags</th><th class="r">Received</th><th class="r">Accepted</th><th class="r">Rejected</th><th>UOM</th></tr></thead><tbody>
      ${(g.lines as any[]).map((l, i) => `<tr><td>${i + 1}</td><td>${e(l.item)}${l.trim_size ? ` (${e(l.trim_size)})` : ''}</td><td>${e(l.color_name ?? '')}</td><td>${e(l.lot_no ?? '')}</td><td class="r">${l.packs ?? ''}</td><td class="r">${q(l.received_qty)}</td><td class="r">${q(l.accepted_qty)}</td><td class="r">${q(l.rejected_qty)}</td><td>${e(l.uom ?? '')}</td></tr>`).join('')}
      </tbody></table>${g.remarks ? `<p>${e(g.remarks)}</p>` : ''}
      <div class="sign"><div>Received by (store)</div><div>QC</div><div>Authorised signatory</div></div>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };
  return (
    <button type="button" onClick={() => void print()} id="btn-print-grn"
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
      <Printer size={14} /> Print GRN
    </button>
  );
}
