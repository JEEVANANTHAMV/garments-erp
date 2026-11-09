import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, execute, type Tx } from '../../config/db.js';
import { Unprocessable } from '../../core/errors.js';
import { openSecret } from '../../core/secretBox.js';

/**
 * TallyPrime mirror (spec §6, §9): queue, XML builder, connectors.
 *
 *  - Every POSTED voucher of a company with an active Tally company gets one acc_tally_queue row (unique per destination +
 *    idempotency key ERP-<company>-V<voucher>). Tally receives the key as the voucher REMOTEID, so importing the same
 *    voucher again (retry, re-imported file) updates that voucher in Tally instead of creating a second one.
 *  - Connector XML_FILE (default until the client's Tally API is confirmed): accounts download the XML (ledgers + vouchers),
 *    import it in Tally (Gateway → Import Data → Vouchers), then mark the rows posted (Tally voucher no optional).
 *  - Connector HTTP: Tally's XML server (Tally → F1 Settings → Connectivity → TallyPrime acts as Server, port 9000).
 *    A worker posts PENDING rows, reads CREATED / ALTERED / ERRORS / LINEERROR. Timeout → UNKNOWN (never "posted").
 *  - Transport is separate from voucher generation: changing the connector never changes accounting rules (§6.3).
 */

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const ymd = (d: string) => String(d).slice(0, 10).replace(/-/g, '');
const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export async function activeTallyCompany(tx: Tx | null, cid: number, fy?: string | null) {
  const sql = `SELECT * FROM acc_tally_company WHERE company_id = ? AND is_active = 1 AND (fy_code IS NULL OR fy_code = '' OR fy_code = ?)
                ORDER BY (fy_code = ?) DESC, id LIMIT 2`;
  const rows = tx ? await txQuery<any>(tx, sql, [cid, fy ?? '', fy ?? '']) : await query<any>(sql, [cid, fy ?? '', fy ?? '']);
  return rows;
}

/** Queue a posted voucher for Tally (no-op when no Tally company is configured). */
export async function enqueueTally(tx: Tx, cid: number, voucherId: number) {
  const v = await txQueryOne<any>(tx, `SELECT id, fy_code, status FROM acc_voucher WHERE id = ? AND company_id = ?`, [voucherId, cid]);
  if (!v || v.status !== 'POSTED' && v.status !== 'REVERSED') return null;
  const dest = await activeTallyCompany(tx, cid, v.fy_code);
  if (!dest.length) return null;
  const exact = dest.filter((d) => d.fy_code === v.fy_code);
  const pick = exact.length === 1 ? exact[0] : dest.length === 1 ? dest[0] : null;
  if (!pick) throw Unprocessable(`More than one active Tally company matches FY ${v.fy_code} — keep one active per year (Accounts → Tally set-up)`, { code: 'MAPPING' });
  const key = `ERP-${cid}-V${voucherId}`;
  const ins: any = await txExecute(tx, `INSERT IGNORE INTO acc_tally_queue (company_id, tally_company_id, voucher_id, idempotency_key, status, next_retry_at)
                       VALUES (?,?,?,?, 'PENDING', NOW())`, [cid, pick.id, voucherId, key]);
  // the voucher's Tally status follows the active destination (a new destination after a company switch starts at PENDING)
  if (Number(ins?.affectedRows)) await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'PENDING', tally_voucher_no = NULL WHERE id = ?`, [voucherId]);
  return Number(ins?.affectedRows) ? key : null;
}

/** Queue every posted voucher that has no row for an ACTIVE Tally company yet (after set-up, or after switching company). */
export async function enqueueBacklog(cid: number) {
  const ids = await query<any>(`SELECT v.id FROM acc_voucher v WHERE v.company_id = ? AND v.status IN ('POSTED','REVERSED')
      AND NOT EXISTS (SELECT 1 FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id AND t.is_active = 1
                       WHERE q.voucher_id = v.id) ORDER BY v.voucher_date, v.id LIMIT 5000`, [cid]);
  let n = 0;
  for (const r of ids) {
    const k = await transaction((tx) => enqueueTally(tx, cid, Number(r.id)));
    if (k) n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ XML
async function voucherData(cid: number, ids: number[]) {
  if (!ids.length) return [];
  const vs = await query<any>(
    `SELECT v.*, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') vdate, vt.tally_voucher_type, COALESCE(pl.tally_name, pl.ledger_name) party_name
       FROM acc_voucher v
       JOIN acc_voucher_type vt ON vt.company_id = v.company_id AND vt.type_code = v.type_code
       LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id
      WHERE v.company_id = ? AND v.id IN (?) ORDER BY v.voucher_date, v.id`, [cid, ids]);
  const es = await query<any>(
    `SELECT e.*, COALESCE(l.tally_name, l.ledger_name) lname, l.is_bill_wise, DATE_FORMAT(e.bill_due_date,'%Y-%m-%d') due
       FROM acc_voucher_entry e JOIN acc_ledger l ON l.id = e.ledger_id WHERE e.voucher_id IN (?) ORDER BY e.voucher_id, e.line_no`, [ids]);
  return vs.map((v) => ({ ...v, entries: es.filter((e) => Number(e.voucher_id) === Number(v.id)) }));
}

const BILLTYPE: Record<string, string> = { NEW: 'New Ref', AGAINST: 'Agst Ref', ADVANCE: 'Advance', ON_ACCOUNT: 'On Account' };

export function voucherXml(v: any, key: string) {
  const lines = v.entries.map((e: any) => {
    const dr = Number(e.debit) > 0;
    const a = dr ? -Number(e.debit) : Number(e.credit);   // Tally: debit = negative amount, ISDEEMEDPOSITIVE Yes
    const bill = Number(e.is_bill_wise) && e.bill_ref_type
      ? `<BILLALLOCATIONS.LIST><NAME>${esc(e.bill_ref_type === 'ON_ACCOUNT' ? '' : e.bill_ref_no ?? '')}</NAME><BILLTYPE>${BILLTYPE[e.bill_ref_type] ?? 'On Account'}</BILLTYPE>${e.due && e.bill_ref_type === 'NEW' ? `<BILLCREDITPERIOD>${ymd(e.due)}</BILLCREDITPERIOD>` : ''}<AMOUNT>${amt(a)}</AMOUNT></BILLALLOCATIONS.LIST>`
      : '';
    return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.lname)}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(a)}</AMOUNT>${bill}</ALLLEDGERENTRIES.LIST>`;
  }).join('');
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(key)}" VCHTYPE="${esc(v.tally_voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`
    + `<DATE>${ymd(v.vdate)}</DATE><VOUCHERTYPENAME>${esc(v.tally_voucher_type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(v.voucher_no)}</VOUCHERNUMBER>`
    + (v.party_name ? `<PARTYLEDGERNAME>${esc(v.party_name)}</PARTYLEDGERNAME>` : '')
    + (v.ref_no ? `<REFERENCE>${esc(v.ref_no)}</REFERENCE>` : '')
    + `<NARRATION>${esc(v.narration ?? '')}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${lines}</VOUCHER></TALLYMESSAGE>`;
}

/** Group + ledger masters used by the vouchers (ACTION Create: Tally skips / reports existing names, never duplicates). */
async function mastersXml(cid: number, voucherIds: number[]) {
  if (!voucherIds.length) return '';
  const leds = await query<any>(
    `SELECT DISTINCT l.*, COALESCE(l.tally_name, l.ledger_name) tname, COALESCE(g.tally_name, g.group_name) gname
       FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id
      WHERE l.id IN (SELECT e.ledger_id FROM acc_voucher_entry e WHERE e.voucher_id IN (?))`, [voucherIds]);
  const groups = await query<any>(
    `SELECT g.*, COALESCE(g.tally_name, g.group_name) gname, COALESCE(p.tally_name, p.group_name) pname
       FROM acc_account_group g LEFT JOIN acc_account_group p ON p.id = g.parent_id
      WHERE g.company_id = ? AND g.is_system = 0 ORDER BY g.parent_id IS NOT NULL, g.id`, [cid]);
  const gx = groups.map((g) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="${esc(g.gname)}" ACTION="Create"><NAME.LIST><NAME>${esc(g.gname)}</NAME></NAME.LIST>`
    + `<PARENT>${esc(g.pname ?? '')}</PARENT><ISSUBLEDGER>No</ISSUBLEDGER><AFFECTSGROSSPROFIT>${Number(g.affects_gross_profit) ? 'Yes' : 'No'}</AFFECTSGROSSPROFIT></GROUP></TALLYMESSAGE>`).join('');
  const lx = leds.map((l) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.tname)}" ACTION="Create"><NAME.LIST><NAME>${esc(l.tname)}</NAME></NAME.LIST>`
    + `<PARENT>${esc(l.gname)}</PARENT><ISBILLWISEON>${Number(l.is_bill_wise) ? 'Yes' : 'No'}</ISBILLWISEON>`
    + (l.gstin ? `<PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>` : '')
    + (l.ledger_type === 'TAX' && l.tax_kind ? `<TAXTYPE>${l.tax_kind === 'TDS' ? 'TDS' : l.tax_kind === 'TCS' ? 'TCS' : 'GST'}</TAXTYPE>${['CGST', 'SGST', 'IGST'].includes(l.tax_kind) ? `<GSTDUTYHEAD>${l.tax_kind === 'SGST' ? 'SGST/UTGST' : l.tax_kind}</GSTDUTYHEAD>` : ''}` : '')
    + `</LEDGER></TALLYMESSAGE>`).join('');
  return gx + lx;
}

function envelope(company: string, report: 'All Masters' | 'Vouchers', body: string) {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>`
    + `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

/** One XML file for manual import: masters envelope + vouchers envelope (Tally imports both from one file). */
export async function exportXml(cid: number, queueIds: number[]) {
  const qs = queueIds.length ? await query<any>(
    `SELECT q.*, t.tally_company_name FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id
      WHERE q.company_id = ? AND q.id IN (?) ORDER BY q.id`, [cid, queueIds]) : [];
  if (!qs.length) throw Unprocessable('Pick vouchers waiting for Tally');
  const companies = [...new Set(qs.map((q) => q.tally_company_name))];
  if (companies.length > 1) throw Unprocessable('Export one Tally company at a time');
  const vids = qs.map((q) => Number(q.voucher_id));
  const vs = await voucherData(cid, vids);
  const keyOf = new Map(qs.map((q) => [Number(q.voucher_id), q.idempotency_key as string]));
  const masters = await mastersXml(cid, vids);
  const vouchers = vs.map((v) => voucherXml(v, keyOf.get(Number(v.id))!)).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- C-ONE ERP → TallyPrime: ${vs.length} voucher(s) for "${esc(companies[0])}". Import: Gateway of Tally → Import → Masters, then Vouchers (same file). -->\n`
    + `<ROOT>${envelope(companies[0], 'All Masters', masters)}${envelope(companies[0], 'Vouchers', vouchers)}</ROOT>`;
  return { xml, company: companies[0], count: vs.length, rows: qs };
}

// ------------------------------------------------------------------ HTTP connector
export interface TallyResult { outcome: 'POSTED' | 'FAILED' | 'UNKNOWN'; created?: number; altered?: number; errors?: number; lastVchId?: string | null; message?: string; http?: number; raw?: string }

export function parseTallyResponse(xml: string, http: number): TallyResult {
  const num = (tag: string) => { const m = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, 'i').exec(xml); return m ? Number(m[1]) : null; };
  const created = num('CREATED'); const altered = num('ALTERED'); const errors = num('ERRORS');
  const lineErr = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => m[1].trim()).join(' | ');
  const last = /<LASTVCHID>\s*([^<]*)<\/LASTVCHID>/i.exec(xml)?.[1]?.trim() || null;
  if (http < 200 || http >= 300) return { outcome: http >= 500 ? 'UNKNOWN' : 'FAILED', http, message: `HTTP ${http}`, raw: xml.slice(0, 4000) };
  if ((errors ?? 0) > 0 || lineErr) return { outcome: 'FAILED', created: created ?? 0, altered: altered ?? 0, errors: errors ?? 1, message: lineErr || 'Tally reported errors', http, raw: xml.slice(0, 4000) };
  if ((created ?? 0) + (altered ?? 0) > 0) return { outcome: 'POSTED', created: created ?? 0, altered: altered ?? 0, errors: 0, lastVchId: last, http, raw: xml.slice(0, 4000) };
  // HTTP 200 alone is not proof (§6.3)
  return { outcome: 'UNKNOWN', http, message: 'Tally answered without CREATED / ALTERED counts', raw: xml.slice(0, 4000) };
}

async function httpPost(tc: any, body: string): Promise<{ status: number; text: string; ms: number }> {
  if (!tc.host) throw Unprocessable('Tally host is not set', { code: 'MAPPING' });
  const url = /^https?:\/\//i.test(tc.host) ? tc.host.replace(/\/$/, '') : `http://${tc.host}:${tc.port || 9000}`;
  const headers: Record<string, string> = { 'content-type': 'text/xml; charset=utf-8' };
  const secret = openSecret(tc.secret_enc);
  if (secret) headers.authorization = secret.includes(':') ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`;
  const t0 = Date.now();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), Number(tc.timeout_ms) || 20000);
  try {
    const r = await fetch(url, { method: 'POST', body, headers, signal: ctl.signal });
    return { status: r.status, text: await r.text(), ms: Date.now() - t0 };
  } finally { clearTimeout(to); }
}

export async function healthCheck(cid: number, tallyCompanyId: number) {
  const tc = await queryOne<any>(`SELECT * FROM acc_tally_company WHERE id = ? AND company_id = ?`, [tallyCompanyId, cid]);
  if (!tc) throw Unprocessable('Tally company not found');
  if (tc.connector !== 'HTTP') return { ok: true, message: `Connector ${tc.connector}: nothing to test — vouchers are exported as an XML file` };
  let ok = false; let msg = '';
  try {
    const body = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER>'
      + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>';
    const r = await httpPost(tc, body);
    const found = r.text.toLowerCase().includes(String(tc.tally_company_name).toLowerCase());
    ok = r.status === 200 && found;
    msg = r.status !== 200 ? `HTTP ${r.status}` : found ? `Connected in ${r.ms} ms — company "${tc.tally_company_name}" is open in Tally` : `Connected, but company "${tc.tally_company_name}" is not loaded in Tally`;
  } catch (err) {
    msg = (err as Error).name === 'AbortError' ? 'Timed out — Tally did not answer' : `Cannot reach Tally: ${(err as Error).message}`;
  }
  await execute(`UPDATE acc_tally_company SET last_health_at = NOW(), last_health_ok = ?, last_health_msg = ? WHERE id = ?`, [ok ? 1 : 0, msg.slice(0, 300), tc.id]);
  return { ok, message: msg };
}

const BACKOFF_MIN = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = 6;

async function finishQueue(q: any, r: TallyResult, actor: number | null, req?: string, ms?: number) {
  await transaction(async (tx) => {
    await txExecute(tx, `INSERT INTO acc_tally_log (queue_id, action, outcome, request_payload, response_payload, http_status, duration_ms, message, actor_id)
                         VALUES (?, 'SUBMIT', ?, ?, ?, ?, ?, ?, ?)`, [q.id, r.outcome, req ?? null, r.raw ?? null, r.http ?? null, ms ?? null, r.message ?? null, actor]);
    const attempts = Number(q.attempts) + 1;
    if (r.outcome === 'POSTED') {
      await txExecute(tx, `UPDATE acc_tally_queue SET status = 'POSTED', attempts = ?, locked_at = NULL, tally_voucher_id = ?, posted_at = NOW(),
                              last_error = NULL, last_error_code = NULL WHERE id = ?`, [attempts, r.lastVchId ?? null, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'POSTED' WHERE id = ?`, [q.voucher_id]);
    } else {
      const status = r.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
      const retryIn = r.outcome === 'FAILED' && r.http && r.http >= 500 && attempts < MAX_ATTEMPTS ? BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] : null;
      await txExecute(tx, `UPDATE acc_tally_queue SET status = ?, attempts = ?, locked_at = NULL, last_error = ?, last_error_code = ?,
                              next_retry_at = ${retryIn ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'} WHERE id = ?`,
        retryIn ? [status, attempts, (r.message ?? '').slice(0, 1000), r.outcome, retryIn, q.id] : [status, attempts, (r.message ?? '').slice(0, 1000), r.outcome, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = ? WHERE id = ?`, [status, q.voucher_id]);
    }
  });
}

/** Send one queue row through the HTTP connector. Safe to repeat: REMOTEID = idempotency key. */
export async function submitQueueRow(cid: number, queueId: number, actor: number | null) {
  const claimed = await transaction(async (tx) => {
    const q = await txQueryOne<any>(tx, `SELECT q.*, t.connector FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id
                                          WHERE q.id = ? AND q.company_id = ? FOR UPDATE`, [queueId, cid]);
    if (!q) throw Unprocessable('Queue row not found');
    if (q.connector !== 'HTTP') throw Unprocessable('This Tally company uses XML file export — download the XML and import it in Tally');
    if (q.status === 'POSTED') return null;
    if (q.status === 'PROCESSING' && q.locked_at && Date.now() - new Date(q.locked_at).getTime() < 5 * 60_000) return null;
    await txExecute(tx, `UPDATE acc_tally_queue SET status = 'PROCESSING', locked_at = NOW() WHERE id = ?`, [q.id]);
    await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'PROCESSING' WHERE id = ?`, [q.voucher_id]);
    return q;
  });
  if (!claimed) return { skipped: true };
  const tc = await queryOne<any>(`SELECT * FROM acc_tally_company WHERE id = ?`, [claimed.tally_company_id]);
  const [v] = await voucherData(cid, [Number(claimed.voucher_id)]);
  const masters = await mastersXml(cid, [Number(claimed.voucher_id)]);
  const vx = envelope(tc.tally_company_name, 'Vouchers', voucherXml(v, claimed.idempotency_key));
  let result: TallyResult; let ms = 0;
  try {
    if (masters) await httpPost(tc, envelope(tc.tally_company_name, 'All Masters', masters));
    const r = await httpPost(tc, vx);
    ms = r.ms;
    result = parseTallyResponse(r.text, r.status);
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    // refused / DNS = the request never reached Tally → retryable FAILED; timeout = may have reached Tally → UNKNOWN
    result = aborted ? { outcome: 'UNKNOWN', message: 'Timed out waiting for Tally — re-send is safe (same REMOTEID updates, not duplicates)' }
      : { outcome: 'FAILED', http: 503, message: `Cannot reach Tally: ${(err as Error).message}` };
  }
  await finishQueue(claimed, result, actor, vx, ms);
  return { skipped: false, outcome: result.outcome, message: result.message };
}

let worker: NodeJS.Timeout | null = null;
/** Every 30 s: push PENDING / due-retry rows of HTTP Tally companies. */
export function startTallyWorker() {
  if (worker || process.env.ACC_TALLY_WORKER === '0') return;
  let busy = false;
  worker = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = await query<any>(`SELECT q.id, q.company_id FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id AND t.is_active = 1 AND t.connector = 'HTTP'
          WHERE (q.status = 'PENDING' OR (q.status = 'FAILED' AND q.next_retry_at IS NOT NULL AND q.attempts < ${MAX_ATTEMPTS}))
            AND (q.next_retry_at IS NULL OR q.next_retry_at <= NOW()) ORDER BY q.id LIMIT 50`);
      for (const r of rows) {
        try { await submitQueueRow(Number(r.company_id), Number(r.id), null); } catch (err) { console.error('[tally] submit', r.id, (err as Error).message); }
      }
    } catch (err) {
      console.error('[tally] worker:', (err as Error).message);
    } finally { busy = false; }
  }, 30_000);
  worker.unref?.();
}
