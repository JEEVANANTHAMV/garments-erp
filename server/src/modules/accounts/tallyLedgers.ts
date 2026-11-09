import { Router, type Request } from 'express';
import { z } from 'zod';
import XLSX from 'xlsx';
import { query, queryOne, transaction, txExecute, txQueryOne, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound, Unprocessable } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { tallyRequest } from './tally.js';

/**
 * Tally ledger list + matching (go-live item, 09-Nov-2026).
 * The client's Tally already has ledgers. Every ERP ledger that goes to Tally must carry the EXACT Tally name, otherwise
 * Tally creates a duplicate. Accounts loads the Tally ledger list (masters XML export, Excel, or fetched from the Tally
 * server), auto-matches (same name → same GSTIN → same name ignoring Ltd / Pvt / A/c / punctuation), fixes the rest by hand,
 * and can create ERP ledgers for Tally-only ledgers (bank, capital, loans …) so their opening balances can be brought in.
 */
export const tallyLedgersRouter = Router();
const VIEW = requireAny('ACCOUNTS.VIEW', 'ACCOUNTS.ENTRY', 'ACCOUNTS.APPROVE', 'ACCOUNTS.ADMIN');
const ADMIN = requirePermission('ACCOUNTS.ADMIN');
const cidOf = (req: Request) => req.user!.companyId;

export interface TallyLedgerRow { name: string; parent: string | null; gstin: string | null; opening: number | null; bills: { name: string; date: string | null; due: string | null; amount: number }[] }

const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, d) => { const c = Number(d); return c < 32 ? '' : String.fromCharCode(c); })
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const tag = (block: string, t: string) => { const m = new RegExp(`<${t.replace(/\./g, '\\.')}(?:\\s[^>]*)?>([\\s\\S]*?)</${t.replace(/\./g, '\\.')}>`, 'i').exec(block); return m ? unesc(m[1]) : null; };
/** Tally amounts: "-1234.50" (Dr negative) or "1234.50 Dr" / "1,234.50 Cr" → Dr + . */
export function tallyAmount(v: string | null | undefined): number | null {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).replace(/,/g, '').trim();
  const m = /(-?\d+(?:\.\d+)?)\s*(Dr|Cr)?/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2]) return m[2].toLowerCase() === 'dr' ? Math.abs(n) : -Math.abs(n);
  return Math.round(-n * 100) / 100;   // Tally XML: Dr is negative
}
const tallyDate = (v: string | null) => (v && /^\d{8}$/.test(v.trim()) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);

/** Text of an uploaded file: Tally writes XML in UTF-16 LE (BOM FF FE) or UTF-8. */
export function decodeText(buf: Buffer) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

/** <LEDGER NAME="…"> blocks of a Tally masters export / collection response. */
export function parseTallyLedgersXml(xml: string): TallyLedgerRow[] {
  const out: TallyLedgerRow[] = [];
  const re = /<LEDGER\b([^>]*)>([\s\S]*?)<\/LEDGER>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attr = /NAME="([^"]*)"/i.exec(m[1])?.[1];
    const name = attr ? unesc(attr) : (tag(m[2], 'NAME') ?? '');
    if (!name) continue;
    const body = m[2];
    const gstin = tag(body, 'PARTYGSTIN') || tag(body, 'GSTIN') || null;
    const bills: TallyLedgerRow['bills'] = [];
    for (const b of body.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/gi)) {
      const bn = tag(b[1], 'NAME'); const amt = tallyAmount(tag(b[1], 'OPENINGBALANCE') ?? tag(b[1], 'AMOUNT'));
      if (bn && amt) bills.push({ name: bn, date: tallyDate(tag(b[1], 'BILLDATE')), due: tallyDate(tag(b[1], 'BILLCREDITPERIOD')), amount: amt });
    }
    out.push({ name, parent: tag(body, 'PARENT') || null, gstin: gstin && /^[0-9A-Z]{15}$/i.test(gstin) ? gstin.toUpperCase() : null,
      opening: tallyAmount(tag(body, 'OPENINGBALANCE')), bills });
  }
  return out;
}

/** Excel / CSV ledger list: Name | Under (group) | GSTIN | Opening (signed, or "Dr" / "Cr" columns). */
export function parseLedgerSheet(buf: Buffer): TallyLedgerRow[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: true });
  const key = (r: Record<string, unknown>, ...names: string[]) => {
    const k = Object.keys(r).find((x) => names.includes(x.trim().toLowerCase()));
    return k ? r[k] : null;
  };
  return rows.map((r) => {
    const name = String(key(r, 'name', 'ledger', 'ledger name', 'particulars') ?? '').trim();
    const dr = Number(key(r, 'dr', 'debit', 'opening dr') ?? 0) || 0; const cr = Number(key(r, 'cr', 'credit', 'opening cr') ?? 0) || 0;
    const signed = key(r, 'opening', 'opening balance', 'balance');
    const opening = signed != null && signed !== '' ? tallyAmountText(signed) : (dr || cr ? Math.round((dr - cr) * 100) / 100 : null);
    const g = key(r, 'gstin', 'gst no', 'gstin/uin');
    return { name, parent: (key(r, 'under', 'group', 'parent') as string | null) ?? null, gstin: g ? String(g).trim().toUpperCase() : null, opening, bills: [] };
  }).filter((r) => r.name);
}
/** Spreadsheet opening: number (Dr +) or "1,234.00 Dr / Cr" text. */
function tallyAmountText(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  const s = String(v).trim();
  if (/dr|cr/i.test(s)) return tallyAmount(s);
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const NOISE = /\b(m\/s|the|ltd|limited|pvt|private|co|company|a\/c|ac|account|accounts|llp|inc)\b/g;
export const normName = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[.,()]/g, ' ').replace(NOISE, ' ').replace(/[^a-z0-9]+/g, '');

async function tallyCo(cid: number, id: number) {
  const t = await queryOne<any>(`SELECT * FROM acc_tally_company WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!t) throw NotFound('Tally company not found');
  return t;
}

async function store(req: Request, tcId: number, rows: TallyLedgerRow[], source: 'FILE' | 'FETCH') {
  const cid = cidOf(req);
  if (!rows.length) throw Unprocessable('No ledgers found — export Masters (Ledgers) from Tally as XML, or use an Excel list with a "Name" column');
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  await transaction(async (tx) => {
    await txExecute(tx, `DELETE FROM acc_tally_ledger WHERE company_id = ? AND tally_company_id = ?`, [cid, tcId]);
    for (const r of uniq) {
      await txExecute(tx, `INSERT INTO acc_tally_ledger (company_id, tally_company_id, tally_name, parent_name, gstin, opening_balance, bills_json, source, imported_by)
                           VALUES (?,?,?,?,?,?,?,?,?)`,
        [cid, tcId, r.name.slice(0, 200), r.parent?.slice(0, 200) ?? null, r.gstin, r.opening, r.bills.length ? JSON.stringify(r.bills) : null, source, req.user!.id]);
    }
  });
  await audit(req, 'acc_tally_ledger', tcId, 'INSERT', undefined, { action: 'IMPORT_TALLY_LEDGERS', source, count: uniq.length });
  return uniq.length;
}

const fileSchema = z.object({ filename: z.string().max(200), content_base64: z.string().min(10, 'Choose the file') });

tallyLedgersRouter.post('/tally/companies/:id/ledgers/import', ADMIN, ah(async (req, res) => {
  const tc = await tallyCo(cidOf(req), Number(req.params.id));
  const b = fileSchema.parse(req.body ?? {});
  const buf = Buffer.from(b.content_base64, 'base64');
  const text = /\.(xml|txt)$/i.test(b.filename) ? decodeText(buf) : null;
  const rows = text != null ? parseTallyLedgersXml(text) : parseLedgerSheet(buf);
  const n = await store(req, Number(tc.id), rows, 'FILE');
  res.json({ data: { imported: n }, message: `${n} Tally ledger(s) loaded from ${b.filename}` });
}));

/** Ask the Tally server for its ledgers (name, group, GSTIN, opening, bill-wise openings). */
tallyLedgersRouter.post('/tally/companies/:id/ledgers/fetch', ADMIN, ah(async (req, res) => {
  const tc = await tallyCo(cidOf(req), Number(req.params.id));
  if (tc.connector !== 'HTTP') throw BadRequest('Fetching needs the Tally server connection — or load an exported masters file');
  const body = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ERPLedgerList</ID></HEADER><BODY><DESC>`
    + `<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${String(tc.tally_company_name).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</SVCURRENTCOMPANY></STATICVARIABLES>`
    + `<TDL><TDLMESSAGE><COLLECTION NAME="ERPLedgerList" ISMODIFY="No"><TYPE>Ledger</TYPE>`
    + `<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>OpeningBalance</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>`
    + `<NATIVEMETHOD>BillAllocations</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const r = await tallyRequest(tc, body);
  if (r.status !== 200) throw Unprocessable(`Tally answered HTTP ${r.status}`);
  const n = await store(req, Number(tc.id), parseTallyLedgersXml(r.text), 'FETCH');
  res.json({ data: { imported: n }, message: `${n} ledger(s) read from Tally` });
}));

/** ERP ledgers ↔ Tally ledgers with status and suggestions. */
tallyLedgersRouter.get('/tally/companies/:id/ledgers', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const tc = await tallyCo(cid, Number(req.params.id));
  const tl = await query<any>(`SELECT id, tally_name, parent_name, gstin, opening_balance, JSON_LENGTH(bills_json) bills, source, imported_at FROM acc_tally_ledger
      WHERE company_id = ? AND tally_company_id = ? ORDER BY tally_name`, [cid, tc.id]);
  const erp = await query<any>(`SELECT l.id, l.ledger_name, l.ledger_code, l.ledger_type, l.tally_name, l.gstin, l.is_system, g.group_name,
        (SELECT COUNT(*) FROM acc_voucher_entry e WHERE e.ledger_id = l.id) used
       FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id WHERE l.company_id = ? AND l.is_active = 1 ORDER BY g.sort_order, l.ledger_name`, [cid]);
  const byLower = new Map(tl.map((t) => [String(t.tally_name).toLowerCase(), t]));
  const sug = suggest(erp, tl);
  const used = new Set<string>();
  const erpRows = erp.map((l) => {
    const eff = String(l.tally_name || l.ledger_name);
    const hit = byLower.get(eff.toLowerCase());
    if (hit) used.add(String(hit.tally_name).toLowerCase());
    return { ...l, effective_name: eff, status: hit ? 'MATCHED' : 'NOT_IN_TALLY', suggestion: hit ? null : (sug.get(Number(l.id)) ?? null) };
  });
  res.json({ data: { tally_company: { id: tc.id, name: tc.tally_company_name }, loaded: tl.length, loaded_at: tl[0]?.imported_at ?? null,
    erp: erpRows, tally_only: tl.filter((t) => !used.has(String(t.tally_name).toLowerCase())) } });
}));

/** Suggestions for unmatched ERP ledgers: same GSTIN → same normalised name (unique only). */
function suggest(erp: any[], tl: any[]) {
  const out = new Map<number, string>();
  const byGstin = new Map<string, any[]>(); const byNorm = new Map<string, any[]>();
  for (const t of tl) {
    if (t.gstin) byGstin.set(t.gstin, [...(byGstin.get(t.gstin) ?? []), t]);
    const k = normName(t.tally_name); if (k) byNorm.set(k, [...(byNorm.get(k) ?? []), t]);
  }
  for (const l of erp) {
    const g = l.gstin ? byGstin.get(String(l.gstin).toUpperCase()) : undefined;
    if (g?.length === 1) { out.set(Number(l.id), g[0].tally_name); continue; }
    const n = byNorm.get(normName(l.ledger_name));
    if (n?.length === 1) out.set(Number(l.id), n[0].tally_name);
  }
  return out;
}

/** Apply every unique suggestion to ledgers whose current Tally name is not in Tally. */
tallyLedgersRouter.post('/tally/companies/:id/ledgers/auto-match', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const tc = await tallyCo(cid, Number(req.params.id));
  const tl = await query<any>(`SELECT tally_name, gstin FROM acc_tally_ledger WHERE company_id = ? AND tally_company_id = ?`, [cid, tc.id]);
  if (!tl.length) throw BadRequest('Load the Tally ledger list first');
  const names = new Set(tl.map((t) => String(t.tally_name).toLowerCase()));
  const erp = await query<any>(`SELECT id, ledger_name, tally_name, gstin FROM acc_ledger WHERE company_id = ? AND is_active = 1`, [cid]);
  const open = erp.filter((l) => !names.has(String(l.tally_name || l.ledger_name).toLowerCase()));
  const sug = suggest(open, tl);
  // two ERP ledgers must never point to one Tally ledger
  const taken = new Set(erp.filter((l) => names.has(String(l.tally_name || l.ledger_name).toLowerCase())).map((l) => String(l.tally_name || l.ledger_name).toLowerCase()));
  let n = 0;
  for (const [id, name] of sug) {
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    await execute(`UPDATE acc_ledger SET tally_name = ?, updated_by = ? WHERE id = ? AND company_id = ?`, [name, req.user!.id, id, cid]);
    n += 1;
  }
  await audit(req, 'acc_ledger', 0, 'UPDATE', undefined, { action: 'TALLY_AUTO_MATCH', matched: n });
  res.json({ data: { matched: n }, message: n ? `${n} ledger(s) matched by GSTIN / name` : 'Nothing more to match automatically — pick the rest by hand' });
}));

/** Set (or clear) the Tally name of one ERP ledger; refuses a Tally ledger already used by another ERP ledger. */
tallyLedgersRouter.put('/tally/ledger-map/:ledgerId', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = Number(req.params.ledgerId);
  const b = z.object({ tally_name: z.string().trim().max(150).nullable() }).parse(req.body ?? {});
  const l = await queryOne<any>(`SELECT id, ledger_name, tally_name FROM acc_ledger WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!l) throw NotFound('Ledger not found');
  if (b.tally_name) {
    const dup = await queryOne<any>(`SELECT ledger_name FROM acc_ledger WHERE company_id = ? AND id <> ? AND LOWER(COALESCE(tally_name, ledger_name)) = LOWER(?)`, [cid, id, b.tally_name]);
    if (dup) throw BadRequest(`"${b.tally_name}" is already the Tally ledger of ${dup.ledger_name}`);
  }
  await execute(`UPDATE acc_ledger SET tally_name = ?, updated_by = ? WHERE id = ?`, [b.tally_name || null, req.user!.id, id]);
  await audit(req, 'acc_ledger', id, 'UPDATE', { tally_name: l.tally_name }, { tally_name: b.tally_name });
  res.json({ data: { id, tally_name: b.tally_name }, message: b.tally_name ? `${l.ledger_name} → ${b.tally_name}` : 'Tally name cleared' });
}));

/** Create ERP ledgers for Tally-only ledgers (same name, linked), in the chosen ERP group. */
tallyLedgersRouter.post('/tally/companies/:id/ledgers/create-in-erp', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  await tallyCo(cid, Number(req.params.id));
  const b = z.object({ items: z.array(z.object({ tally_name: z.string().trim().min(1).max(150), group_id: z.coerce.number().int().positive() })).min(1).max(1000) }).parse(req.body ?? {});
  let n = 0;
  const skipped: string[] = [];
  await transaction(async (tx) => {
    for (const it of b.items) {
      const g = await txQueryOne<any>(tx, `SELECT id, group_code, parent_id FROM acc_account_group WHERE id = ? AND company_id = ? AND is_active = 1`, [it.group_id, cid]);
      if (!g) throw BadRequest(`Pick an ERP group for ${it.tally_name}`);
      const clash = await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND (LOWER(ledger_name) = LOWER(?) OR LOWER(tally_name) = LOWER(?))`, [cid, it.tally_name, it.tally_name]);
      if (clash) { skipped.push(it.tally_name); continue; }
      const parent = g.parent_id ? await txQueryOne<any>(tx, `SELECT group_code FROM acc_account_group WHERE id = ?`, [g.parent_id]) : null;
      const codeOf = [g.group_code, parent?.group_code];
      const type = codeOf.includes('BANK_ACCOUNTS') || codeOf.includes('BANK_OD') ? 'BANK' : codeOf.includes('CASH_IN_HAND') ? 'CASH'
        : codeOf.includes('DUTIES_TAXES') ? 'TAX' : codeOf.includes('STOCK_IN_HAND') ? 'STOCK' : 'GENERAL';
      const billWise = codeOf.includes('SUNDRY_DEBTORS') || codeOf.includes('SUNDRY_CREDITORS') ? 1 : 0;
      const tlRow = await txQueryOne<any>(tx, `SELECT gstin FROM acc_tally_ledger WHERE company_id = ? AND tally_name = ? LIMIT 1`, [cid, it.tally_name]);
      const code = `T-${it.tally_name}`.toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/-+/g, '-').slice(0, 36);
      let c = code; let k = 1;
      while (await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND ledger_code = ?`, [cid, c])) c = `${code.slice(0, 33)}-${++k}`;
      await txExecute(tx, `INSERT INTO acc_ledger (company_id, ledger_code, ledger_name, group_id, ledger_type, is_bill_wise, gstin, state_code, tally_name, remarks, created_by)
                           VALUES (?,?,?,?,?,?,?,?,?, 'Created from the Tally ledger list', ?)`,
        [cid, c, it.tally_name.slice(0, 150), g.id, type, billWise, tlRow?.gstin ?? null, tlRow?.gstin ? String(tlRow.gstin).slice(0, 2) : null, it.tally_name, req.user!.id]);
      n += 1;
    }
  });
  await audit(req, 'acc_ledger', 0, 'INSERT', undefined, { action: 'CREATE_FROM_TALLY', created: n, skipped });
  res.json({ data: { created: n, skipped }, message: `${n} ERP ledger(s) created${skipped.length ? `, ${skipped.length} already existed` : ''}` });
}));

/** Ledger names that already exist in Tally for a destination (XML masters skip them). */
export async function tallyKnownNames(tallyCompanyId: number) {
  const rows = await query<any>(`SELECT LOWER(tally_name) n FROM acc_tally_ledger WHERE tally_company_id = ?`, [tallyCompanyId]);
  return new Set(rows.map((r) => String(r.n)));
}
