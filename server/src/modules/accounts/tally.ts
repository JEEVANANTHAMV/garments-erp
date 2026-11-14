import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, execute, type Tx } from '../../config/db.js';
import { Unprocessable } from '../../core/errors.js';
import { openSecret } from '../../core/secretBox.js';

/**
 * TallyPrime mirror (spec §6, §9): queue, XML builder, connectors.
 *
 *  - Every POSTED voucher of a company with an active Tally company gets one acc_tally_queue row (unique per destination +
 *    idempotency key ERP-<company>-V<voucher>, sent as REMOTEID). TallyPrime does not keep that REMOTEID on new vouchers, so the
 *    HTTP connector protects against duplicates by voucher type + ERP number instead (see "duplicate protection").
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

/**
 * Bill due date as Tally's credit period. TallyPrime 7.1 only keeps it in its own export form —
 * <BILLCREDITPERIOD JD="<voucher date as Tally day no>" P="30 Days">30 Days</BILLCREDITPERIOD> (verified 14-Nov-2026);
 * a plain date or a bare "30 Days" is silently dropped (blank due date). JD = days since 31-Dec-1899 (5-Nov-2026 = 46330).
 */
export function creditPeriod(vdate: string | Date | null | undefined, due: string | Date | null | undefined) {
  if (!vdate || !due) return '';
  const day = (d: string | Date) => d instanceof Date ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) : Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  const days = Math.round((day(due) - day(vdate)) / 86_400_000);
  if (!Number.isFinite(days) || days <= 0) return '';
  const jd = Math.round((day(vdate) - Date.UTC(1899, 11, 31)) / 86_400_000);
  return `<BILLCREDITPERIOD JD="${jd}" P="${days} Days">${days} Days</BILLCREDITPERIOD>`;
}

export function voucherXml(v: any, key: string) {
  const lines = v.entries.map((e: any) => {
    const dr = Number(e.debit) > 0;
    const a = dr ? -Number(e.debit) : Number(e.credit);   // Tally: debit = negative amount, ISDEEMEDPOSITIVE Yes
    const bill = Number(e.is_bill_wise) && e.bill_ref_type
      ? `<BILLALLOCATIONS.LIST><NAME>${esc(e.bill_ref_type === 'ON_ACCOUNT' ? '' : e.bill_ref_no ?? '')}</NAME><BILLTYPE>${BILLTYPE[e.bill_ref_type] ?? 'On Account'}</BILLTYPE>${e.bill_ref_type === 'NEW' ? creditPeriod(v.vdate, e.due) : ''}<AMOUNT>${amt(a)}</AMOUNT></BILLALLOCATIONS.LIST>`
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
async function mastersXml(cid: number, voucherIds: number[], tallyCompanyId: number) {
  if (!voucherIds.length) return '';
  // ledgers already in this Tally company (from its loaded ledger list) are not sent again
  const known = new Set((await query<any>(`SELECT LOWER(tally_name) n FROM acc_tally_ledger WHERE tally_company_id = ?`, [tallyCompanyId])).map((r) => String(r.n)));
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
  const lx = leds.filter((l) => !known.has(String(l.tname).toLowerCase())).map((l) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.tname)}" ACTION="Create"><NAME.LIST><NAME>${esc(l.tname)}</NAME></NAME.LIST>`
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
  const masters = await mastersXml(cid, vids, Number(qs[0].tally_company_id));
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
  // TallyPrime 7.1 reports e.g. a missing ledger as EXCEPTIONS=1 with ERRORS=0 (+ LINEERROR) — both mean "not saved"
  const exceptions = num('EXCEPTIONS');
  const lineErr = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => xmlText(m[1])).join(' | ');
  const last = /<LASTVCHID>\s*([^<]*)<\/LASTVCHID>/i.exec(xml)?.[1]?.trim() || null;
  if (http < 200 || http >= 300) return { outcome: http >= 500 ? 'UNKNOWN' : 'FAILED', http, message: `HTTP ${http}`, raw: xml.slice(0, 4000) };
  if ((errors ?? 0) > 0 || (exceptions ?? 0) > 0 || lineErr) return { outcome: 'FAILED', created: created ?? 0, altered: altered ?? 0, errors: Math.max(errors ?? 0, exceptions ?? 0, 1), message: lineErr || 'Tally reported errors', http, raw: xml.slice(0, 4000) };
  if ((created ?? 0) + (altered ?? 0) > 0) return { outcome: 'POSTED', created: created ?? 0, altered: altered ?? 0, errors: 0, lastVchId: last, http, raw: xml.slice(0, 4000) };
  // HTTP 200 alone is not proof (§6.3)
  return { outcome: 'UNKNOWN', http, message: 'Tally answered without CREATED / ALTERED counts', raw: xml.slice(0, 4000) };
}

/**
 * Tally's XML server works on ONE request at a time, and a slow or stuck request blocks everything behind it (seen on the
 * client's TallyPrime 7.1, 14-Nov-2026). So every request to the same Tally server waits for the previous one to finish —
 * the worker, "Test connection" and "Fetch ledgers" never hit Tally in parallel.
 */
const tallyLane = new Map<string, Promise<unknown>>();

/** POST an XML request to the Tally server of a destination (also used to read Tally's ledger list). */
export async function tallyRequest(tc: any, body: string, timeoutMs?: number): Promise<{ status: number; text: string; ms: number }> {
  if (!tc.host) throw Unprocessable('Tally host is not set', { code: 'MAPPING' });
  const url = /^https?:\/\//i.test(tc.host) ? tc.host.replace(/\/$/, '') : `http://${tc.host}:${tc.port || 9000}`;
  const prev = tallyLane.get(url) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => sendToTally(tc, url, body, timeoutMs));
  tallyLane.set(url, run.catch(() => undefined));
  return run;
}

async function sendToTally(tc: any, url: string, body: string, timeoutMs?: number): Promise<{ status: number; text: string; ms: number }> {
  const headers: Record<string, string> = { 'content-type': 'text/xml; charset=utf-8' };
  const secret = openSecret(tc.secret_enc);
  if (secret) headers.authorization = secret.includes(':') ? `Basic ${Buffer.from(secret).toString('base64')}` : `Bearer ${secret}`;
  const t0 = Date.now();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs ?? (Number(tc.timeout_ms) || 20000));
  try {
    const r = await fetch(url, { method: 'POST', body, headers, signal: ctl.signal });
    return { status: r.status, text: await r.text(), ms: Date.now() - t0 };
  } finally { clearTimeout(to); }
}

// ------------------------------------------------------------------ duplicate protection
/*
 * TallyPrime does NOT keep the REMOTEID we send on a new voucher (it stores its own GUID — verified on the client's
 * TallyPrime 7.1), so REMOTEID alone cannot stop a second copy after a timeout or retry. Instead:
 *   1. the ERP voucher number is kept in Tally — the voucher type must number "Automatic (Manual Override)" or "Manual";
 *   2. before every send the worker looks the voucher up in Tally by type + number (ERP numbers carry the FY, so they are
 *      unique in the company; Tally ignores the date range on this collection); found → marked posted, never sent again;
 *   3. if the lookup itself fails, nothing is sent (retry later) — a missed lookup must never become a duplicate.
 * Requests are small (voucher type list; a filtered voucher lookup, 135 ms on the TEST company — re-measure on live data).
 */
const LOOKUP_MS = 15000;
// Tally's internal NumberingMethod values: "Default" = Automatic (renumbers what we send — refused). "None" is what TallyPrime 7.1
// reports after the type is set to keep the typed number; verified 14-Nov-2026: a voucher sent as TESTNUM/0001 stayed TESTNUM/0001.
const KEEPS_OUR_NUMBER = new Set(['automatic (manual override)', 'manual', 'none']);
const formulaText = (s: unknown) => String(s ?? '').replace(/"/g, '');

function collectionXml(company: string, id: string, type: string, fetch: string, o: { inner?: string; after?: string; vars?: string } = {}) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC>`
    + `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>${o.vars ?? ''}</STATICVARIABLES>`
    + `<TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fetch}</FETCH>${o.inner ?? ''}</COLLECTION>${o.after ?? ''}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

/** Numbering method per Tally voucher type name (lower-case keys). */
export async function tallyVoucherTypes(tc: any): Promise<Map<string, string>> {
  const r = await tallyRequest(tc, collectionXml(tc.tally_company_name, 'ERPVchTypes', 'VoucherType', 'Name, NumberingMethod'), LOOKUP_MS);
  if (r.status !== 200) throw new Error(`Tally answered HTTP ${r.status}`);
  const out = new Map<string, string>();
  for (const m of r.text.matchAll(/<VOUCHERTYPE NAME="([^"]*)"[^>]*>([\s\S]*?)<\/VOUCHERTYPE>/gi)) {
    out.set(xmlText(m[1]).toLowerCase(), xmlText(/<NUMBERINGMETHOD[^>]*>([^<]*)</i.exec(m[2])?.[1] ?? ''));
  }
  return out;
}
const xmlText = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

/** Problem with a voucher type's numbering (null = fine). */
export function numberingProblem(types: Map<string, string>, vchType: string) {
  const m = types.get(String(vchType).toLowerCase());
  if (m === undefined) return `Voucher type "${vchType}" does not exist in Tally`;
  if (!KEEPS_OUR_NUMBER.has(m.toLowerCase())) return `Tally voucher type "${vchType}" numbers vouchers "${m || 'automatically'}" — set Method of Voucher Numbering to "Automatic (Manual Override)" (Alt+G → Alter → Voucher Type) so the ERP number is kept and re-sends can be matched`;
  return null;
}

/** Find a voucher in Tally by type + number (the date only narrows when Tally honours it). Returns its Tally master id, or null when not there. Throws when Tally cannot answer. */
export async function findTallyVoucher(tc: any, vchType: string, vchNo: string, date: string): Promise<{ masterId: string | null } | null> {
  const d = ymd(date);
  const xml = collectionXml(tc.tally_company_name, 'ERPVchFind', 'Voucher', 'VoucherNumber, VoucherTypeName, MasterId', {
    inner: '<FILTER>ERPVchFindF</FILTER>',
    after: `<SYSTEM TYPE="Formulae" NAME="ERPVchFindF">$VoucherNumber = "${esc(formulaText(vchNo))}" AND $VoucherTypeName = "${esc(formulaText(vchType))}"</SYSTEM>`,
    vars: `<SVFROMDATE>${d}</SVFROMDATE><SVTODATE>${d}</SVTODATE>`,
  });
  const r = await tallyRequest(tc, xml, LOOKUP_MS);
  if (r.status !== 200) throw new Error(`Tally answered HTTP ${r.status}`);
  const hit = [...r.text.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)].find((m) => {
    const no = /<VOUCHERNUMBER[^>]*>([^<]*)</i.exec(m[1])?.[1];
    return no !== undefined && xmlText(no) === String(vchNo).trim();
  });
  if (!hit) return null;
  return { masterId: /<MASTERID[^>]*>\s*([^<]*?)\s*</i.exec(hit[1])?.[1] ?? null };
}

export async function healthCheck(cid: number, tallyCompanyId: number) {
  const tc = await queryOne<any>(`SELECT * FROM acc_tally_company WHERE id = ? AND company_id = ?`, [tallyCompanyId, cid]);
  if (!tc) throw Unprocessable('Tally company not found');
  if (tc.connector !== 'HTTP') return { ok: true, message: `Connector ${tc.connector}: nothing to test — vouchers are exported as an XML file` };
  let ok = false; let msg = '';
  try {
    const body = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER>'
      + '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>';
    const r = await tallyRequest(tc, body);
    const found = r.text.toLowerCase().includes(String(tc.tally_company_name).toLowerCase());
    ok = r.status === 200 && found;
    msg = r.status !== 200 ? `HTTP ${r.status}` : found ? `Connected in ${r.ms} ms — company "${tc.tally_company_name}" is open in Tally` : `Connected, but company "${tc.tally_company_name}" is not loaded in Tally`;
    if (ok) {
      // the voucher types the ERP sends must keep the ERP number (duplicate protection)
      const types = await tallyVoucherTypes(tc);
      typeCache.set(Number(tc.id), { at: Date.now(), types });
      const used = await query<any>(`SELECT DISTINCT tally_voucher_type t FROM acc_voucher_type WHERE company_id = ? AND tally_voucher_type IS NOT NULL`, [cid]);
      const bad = used.map((u) => numberingProblem(types, u.t)).filter(Boolean) as string[];
      if (bad.length) {
        ok = false;
        const names = used.filter((u) => numberingProblem(types, u.t)).map((u) => `"${u.t}"`).join(', ');
        msg += `. Fix before posting — voucher type(s) ${names}: ${bad.some((b) => b.includes('does not exist')) ? 'missing in Tally or ' : ''}not set to keep the ERP number. In Tally: Alt+G → Alter → Voucher Type → Method of Voucher Numbering = "Automatic (Manual Override)"`;
      } else msg += '; voucher numbering OK';
    }
  } catch (err) {
    msg = (err as Error).name === 'AbortError' ? 'Timed out — Tally did not answer' : `Cannot reach Tally: ${(err as Error).message}`;
  }
  await execute(`UPDATE acc_tally_company SET last_health_at = NOW(), last_health_ok = ?, last_health_msg = ? WHERE id = ?`, [ok ? 1 : 0, msg.slice(0, 300), tc.id]);
  return { ok, message: msg };
}

const BACKOFF_MIN = [1, 5, 15, 60, 240];
const MAX_ATTEMPTS = 6;

async function finishQueue(q: any, r: TallyResult, actor: number | null, req?: string, ms?: number, vchNo?: string) {
  await transaction(async (tx) => {
    await txExecute(tx, `INSERT INTO acc_tally_log (queue_id, action, outcome, request_payload, response_payload, http_status, duration_ms, message, actor_id)
                         VALUES (?, 'SUBMIT', ?, ?, ?, ?, ?, ?, ?)`, [q.id, r.outcome, req ?? null, r.raw ?? null, r.http ?? null, ms ?? null, r.message ?? null, actor]);
    const attempts = Number(q.attempts) + 1;
    if (r.outcome === 'POSTED') {
      await txExecute(tx, `UPDATE acc_tally_queue SET status = 'POSTED', attempts = ?, locked_at = NULL, tally_voucher_id = ?, tally_voucher_no = COALESCE(?, tally_voucher_no),
                              posted_at = NOW(), last_error = NULL, last_error_code = NULL, next_retry_at = NULL WHERE id = ?`, [attempts, r.lastVchId ?? null, vchNo ?? null, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'POSTED', tally_voucher_no = COALESCE(?, tally_voucher_no) WHERE id = ?`, [vchNo ?? null, q.voucher_id]);
    } else {
      const status = r.outcome === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
      // UNKNOWN is retried too: every try looks the voucher up in Tally before sending
      const retryIn = (r.outcome === 'UNKNOWN' || (r.http && r.http >= 500)) && attempts < MAX_ATTEMPTS ? BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] : null;
      await txExecute(tx, `UPDATE acc_tally_queue SET status = ?, attempts = ?, locked_at = NULL, last_error = ?, last_error_code = ?,
                              next_retry_at = ${retryIn ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'} WHERE id = ?`,
        retryIn ? [status, attempts, (r.message ?? '').slice(0, 1000), r.outcome, retryIn, q.id] : [status, attempts, (r.message ?? '').slice(0, 1000), r.outcome, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = ? WHERE id = ?`, [status, q.voucher_id]);
    }
  });
}

const typeCache = new Map<number, { at: number; types: Map<string, string> }>();
async function cachedVoucherTypes(tc: any) {
  const c = typeCache.get(Number(tc.id));
  if (c && Date.now() - c.at < 60_000) return c.types;   // short: a numbering change in Tally is seen within a minute
  const types = await tallyVoucherTypes(tc);
  typeCache.set(Number(tc.id), { at: Date.now(), types });
  return types;
}

/**
 * Send one queue row through the HTTP connector. Safe to repeat: the voucher is looked up in Tally first (type + ERP number)
 * and only sent when Tally does not have it.
 */
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
  const vx = envelope(tc.tally_company_name, 'Vouchers', voucherXml(v, claimed.idempotency_key));
  let result: TallyResult; let ms = 0; let sending = false; let req: string | undefined;
  try {
    const problem = numberingProblem(await cachedVoucherTypes(tc), v.tally_voucher_type);
    if (problem) {
      typeCache.delete(Number(tc.id));   // re-read after the user fixes Tally and retries
      result = { outcome: 'FAILED', message: problem };
    } else {
      const found = await findTallyVoucher(tc, v.tally_voucher_type, v.voucher_no, v.vdate);
      if (found) {
        result = { outcome: 'POSTED', lastVchId: found.masterId, message: `Already in Tally (${v.tally_voucher_type} ${v.voucher_no}) — matched, not sent again` };
      } else {
        const masters = await mastersXml(cid, [Number(claimed.voucher_id)], Number(claimed.tally_company_id));
        if (masters) await tallyRequest(tc, envelope(tc.tally_company_name, 'All Masters', masters));
        sending = true; req = vx;
        const r = await tallyRequest(tc, vx);
        ms = r.ms;
        result = parseTallyResponse(r.text, r.status);
      }
    }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    // a timeout while SENDING may have reached Tally → UNKNOWN (the next try looks it up first, so it is never doubled);
    // anything else (refused, timeout on a lookup) never created a voucher → retryable FAILED
    result = aborted && sending ? { outcome: 'UNKNOWN', message: 'Timed out waiting for Tally — the next try checks Tally first, so it is never posted twice' }
      : { outcome: 'FAILED', http: 503, message: aborted ? 'Tally did not answer in time (it may be busy or showing a message on screen)' : `Cannot reach Tally: ${(err as Error).message}` };
  }
  await finishQueue(claimed, result, actor, req, ms, v?.voucher_no);
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
          WHERE (q.status = 'PENDING' OR (q.status IN ('FAILED','UNKNOWN') AND q.next_retry_at IS NOT NULL AND q.attempts < ${MAX_ATTEMPTS}))
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
