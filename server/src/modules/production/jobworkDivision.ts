import { Router, type Request } from 'express';
import { queryOne, query, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { nextDocNumber } from '../../core/numbering.js';

/**
 * Printing / Embroidery divisions (db/63_divisions.sql). Customer job work
 * (Job Work In) is done and billed by a division; the invoice header prints
 * the division's billing name, e.g. "CK Exports - Printing Division".
 */

/** Division process implied by a free-text job work process ("Screen Printing" -> PRINTING). */
export function divisionProcessOf(processType: unknown): 'PRINTING' | 'EMBROIDERY' | null {
  const p = String(processType ?? '').toLowerCase();
  if (p.includes('embroid')) return 'EMBROIDERY';
  if (p.includes('print')) return 'PRINTING';
  return null;
}

async function divisionForProcess(tx: Tx, companyId: number, processType: unknown): Promise<number | null> {
  const proc = divisionProcessOf(processType);
  if (!proc) return null;
  const d = await txQueryOne<{ id: number }>(tx,
    `SELECT id FROM mst_division
      WHERE company_id = ? AND process_type = ? AND is_active = 1 AND is_deleted = 0
      ORDER BY id LIMIT 1`, [companyId, proc]);
  return d?.id ?? null;
}

async function assertDivision(tx: Tx, companyId: number, id: unknown) {
  const d = await txQueryOne<{ id: number; division_code: string; invoice_prefix: string | null }>(tx,
    `SELECT id, division_code, invoice_prefix FROM mst_division WHERE id = ? AND company_id = ? AND is_deleted = 0`,
    [id, companyId]);
  if (!d) throw BadRequest('Division not found');
  return d;
}

/** Job Work In: a Printing / Embroidery process defaults the division. */
export async function jobworkInBeforeCreate(req: Request, data: Record<string, unknown>, tx: Tx) {
  const companyId = req.user!.companyId;
  if (data.division_id) await assertDivision(tx, companyId, data.division_id);
  else data.division_id = await divisionForProcess(tx, companyId, data.process_type);
}

/**
 * Job Work Invoice: division defaults from the Job Work In (its division, else
 * its process); a division invoice is numbered from that division's own series.
 */
export async function jobworkInvoiceBeforeCreate(req: Request, data: Record<string, unknown>, tx: Tx) {
  const companyId = req.user!.companyId;
  if (!data.division_id && data.jwin_id) {
    const jw = await txQueryOne<{ division_id: number | null; process_type: string | null }>(tx,
      `SELECT division_id, process_type FROM trx_jobwork_in WHERE id = ? AND company_id = ?`,
      [data.jwin_id, companyId]);
    if (jw) data.division_id = jw.division_id ?? await divisionForProcess(tx, companyId, jw.process_type);
  }
  if (!data.division_id) return;
  const d = await assertDivision(tx, companyId, data.division_id);
  if (data.invoice_no) return;
  const docType = `JW_INV_DIV_${d.id}`;
  // Seed the series with the division prefix (a division added after the migration).
  await txExecute(tx,
    `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
     SELECT ?, NULL, ?, NULL, ?, 1, 5 FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series WHERE company_id = ? AND doc_type = ?)`,
    [companyId, docType, d.invoice_prefix || `${d.division_code}-`, companyId, docType]);
  data.invoice_no = await nextDocNumber(tx, companyId, docType);
}

/* ------------------------------------------------------------------ Print */

export const jobworkDivisionRouter = Router();

const addr = (...parts: (string | null | undefined)[]) => parts.map((p) => (p ?? '').trim()).filter(Boolean).join(', ');

/** Printable Job Work Invoice: division billing header + customer + job work + GST split. */
jobworkDivisionRouter.get('/jobwork-invoices/:id/print', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw BadRequest('Invalid id');
  const companyId = req.user!.companyId;

  const inv = await queryOne<any>(
    `SELECT t.*, cur.code AS currency_code, cur.symbol AS currency_symbol
       FROM trx_jobwork_invoice t
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
      WHERE t.id = ? AND t.company_id = ?`, [id, companyId]);
  if (!inv) throw NotFound('Job Work Invoice not found');

  const co = await queryOne<any>(`SELECT * FROM mst_company WHERE id = ?`, [companyId]);
  const div = inv.division_id
    ? await queryOne<any>(`SELECT * FROM mst_division WHERE id = ? AND company_id = ?`, [inv.division_id, companyId])
    : null;
  const coName = co?.trade_name || co?.legal_name || '';
  // Division overrides win field by field; blank falls back to the company.
  const hasDivAddr = !!(div?.address_line1 || div?.city);
  const issuer = {
    billing_name: div?.billing_name || coName,
    company_name: co?.legal_name || coName,
    division_name: div?.division_name ?? null,
    gstin: div?.gstin || co?.gstin || null,
    pan: co?.pan || null,
    address: hasDivAddr
      ? addr(div.address_line1, div.address_line2, div.city, div.state, div.pincode)
      : addr(co?.address_line1, co?.address_line2, co?.city, co?.state, co?.pincode),
    state: (hasDivAddr ? div.state : co?.state) || null,
    phone: div?.phone || co?.phone || null,
    email: div?.email || co?.email || null,
    bank: div?.bank_name || div?.bank_account_no
      ? { bank_name: div.bank_name, account_no: div.bank_account_no, ifsc: div.bank_ifsc, branch: div.bank_branch }
      : null,
  };

  const party = await queryOne<any>(
    `SELECT p.party_name, p.legal_name, p.gstin,
            pa.address_line1, pa.address_line2, pa.city, pa.state, pa.pincode, pa.phone
       FROM mst_party p
       LEFT JOIN mst_party_address pa ON pa.id = (
             SELECT a.id FROM mst_party_address a WHERE a.party_id = p.id AND a.is_active = 1
              ORDER BY a.address_type = 'BILLING' DESC, a.is_default DESC, a.id LIMIT 1)
      WHERE p.id = ?`, [inv.party_id]);

  const jw = inv.jwin_id
    ? await queryOne<any>(
        `SELECT jwin_no, jwin_date, customer_dc_no, customer_po_ref, process_type, total_qty, rate
           FROM trx_jobwork_in WHERE id = ? AND company_id = ?`, [inv.jwin_id, companyId])
    : null;
  const jwLines = inv.jwin_id
    ? await query<any>(
        `SELECT l.description, l.material_type, l.qty, l.processed_qty, u.code AS uom
           FROM trx_jobwork_in_line l LEFT JOIN cfg_uom u ON u.id = l.uom_id
          WHERE l.jwin_id = ? ORDER BY l.id`, [inv.jwin_id])
    : [];

  const taxable = Number(inv.taxable_amount || 0);
  const gst = Number(inv.gst_amount || 0);
  const gstPct = taxable > 0 ? Math.round((gst / taxable) * 10000) / 100 : 0;
  // Same state (GSTIN state code) -> CGST + SGST; otherwise IGST.
  const fromState = String(issuer.gstin || co?.state_gst_code || '').slice(0, 2);
  const toState = String(party?.gstin || '').slice(0, 2);
  const interState = !!(fromState && toState && fromState !== toState);
  const half = Math.round((gst / 2) * 100) / 100;

  res.json({
    data: {
      invoice: {
        id: inv.id, invoice_no: inv.invoice_no, invoice_date: inv.invoice_date,
        invoice_type: inv.invoice_type, status: inv.status, hsn_code: inv.hsn_code,
        currency_code: inv.currency_code, currency_symbol: inv.currency_symbol, remarks: inv.remarks,
      },
      issuer,
      party: party && {
        name: party.legal_name || party.party_name, gstin: party.gstin,
        address: addr(party.address_line1, party.address_line2, party.city, party.state, party.pincode),
        state: party.state, phone: party.phone,
      },
      jobwork: jw,
      lines: [{
        description: [jw?.process_type, jwLines.map((l: any) => l.description).filter(Boolean).join(', ')].filter(Boolean).join(' - ') || 'Job work charges',
        process: jw?.process_type ?? null,
        customer_dc_no: jw?.customer_dc_no ?? null,
        hsn_code: inv.hsn_code,
        qty: Number(inv.total_qty || jw?.total_qty || 0),
        rate: Number(inv.rate || jw?.rate || 0),
        amount: taxable,
      }],
      jobwork_lines: jwLines,
      totals: {
        taxable_amount: taxable, gst_pct: gstPct, gst_amount: gst,
        inter_state: interState,
        cgst: interState ? 0 : half, sgst: interState ? 0 : Math.round((gst - half) * 100) / 100,
        igst: interState ? gst : 0,
        total_amount: Number(inv.total_amount || taxable + gst),
      },
    },
  });
}));
