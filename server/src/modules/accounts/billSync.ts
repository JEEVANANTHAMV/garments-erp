import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';

/**
 * Bill tracker ↔ Accounts (BT_POSTING_ADAPTER = ACCOUNTS, migration 159).
 * A tracked bill's posting is satisfied by the Accounts module: when every Bills Inward / process / contractor bill linked
 * to the tracked bill has a POSTED voucher, the tracker posting becomes POSTED with those voucher numbers. If such a voucher
 * is later reversed / cancelled, the tracker posting goes to RECON_REQUIRED. Nobody types the bill into Tally a second time.
 */
const LINK_KEY: Record<string, string> = {
  SUPPLIER_BILL: 'SUPPLIER_BILL:APPROVE', KNITTING_BILL: 'KNITTING_BILL:POST', FABRIC_PROCESS_BILL: 'FABRIC_PROCESS_BILL:POST',
  YARN_PROCESS_BILL: 'YARN_PROCESS_BILL:POST', CONTRACTOR_BILL: 'CONTRACTOR_BILL:APPROVE',
};

export async function billTrackerViaAccounts(cid: number) {
  const s = await queryOne<any>(`SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'BT_POSTING_ADAPTER'`, [cid]);
  return String(s?.v ?? '').toUpperCase() === 'ACCOUNTS';
}

export async function syncBillTracker(cid: number) {
  if (!(await billTrackerViaAccounts(cid))) return { posted: 0, recon: 0 };
  const rows = await query<any>(`SELECT p.id, p.bill_id, p.status, p.attempts, p.response_summary FROM trx_bill_posting p
      WHERE p.company_id = ? AND p.status IN ('QUEUED','POSTING','UNKNOWN','FAILED','RECON_REQUIRED','POSTED') ORDER BY p.id LIMIT 2000`, [cid]);
  let posted = 0; let recon = 0;
  for (const p of rows) {
    const links = await query<any>(`SELECT link_type, target_id, target_no FROM trx_bill_tracker_link
        WHERE bill_id = ? AND removed_at IS NULL AND link_type IN (?)`, [p.bill_id, Object.keys(LINK_KEY)]);
    if (!links.length) {
      const msg = 'Waiting: link the Bills Inward / process / contractor bill so Accounts can post it';
      if (p.status !== 'POSTED' && p.response_summary !== msg) await query(`UPDATE trx_bill_posting SET response_summary = ? WHERE id = ?`, [msg, p.id]);
      continue;
    }
    const vs = await query<any>(`SELECT source_key, status, voucher_no, DATE_FORMAT(voucher_date,'%Y-%m-%d') d FROM acc_voucher
        WHERE company_id = ? AND source_key IN (?)`, [cid, links.map((l) => `${LINK_KEY[l.link_type]}:${l.target_id}:1`)]);
    const by = new Map(vs.map((v) => [v.source_key, v]));
    const each = links.map((l) => ({ l, v: by.get(`${LINK_KEY[l.link_type]}:${l.target_id}:1`) }));
    const allPosted = each.every((x) => x.v?.status === 'POSTED');
    if (allPosted && p.status !== 'POSTED') {
      const nos = each.map((x) => x.v.voucher_no).join(', ').slice(0, 60);
      const date = each.map((x) => x.v.d).sort().at(-1);
      await transaction(async (tx) => {
        const cur = await txQueryOne<any>(tx, `SELECT status FROM trx_bill_posting WHERE id = ? FOR UPDATE`, [p.id]);
        if (!cur || cur.status === 'POSTED') return;
        await txExecute(tx, `UPDATE trx_bill_posting SET status = 'POSTED', external_voucher_no = ?, external_voucher_date = ?, posted_at = NOW(), attempts = attempts + 1,
            response_code = 'ACCOUNTS', response_summary = 'Posted by the Accounts module', last_error_code = NULL, last_error_summary = NULL, row_version = row_version + 1 WHERE id = ?`, [nos, date, p.id]);
        await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, voucher_no, reason) VALUES (?,?,'ACCOUNTS_SYNC','POSTED',?,?)`,
          [p.id, Number(p.attempts) + 1, nos, 'Accounts voucher posted']);
        await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'POSTED', external_voucher_no = ?, external_voucher_date = ?, row_version = row_version + 1 WHERE id = ?`,
          [nos, date, p.bill_id]);
      });
      posted += 1;
    } else if (!allPosted && p.status === 'POSTED') {
      const gone = each.filter((x) => x.v?.status !== 'POSTED').map((x) => x.l.target_no).join(', ');
      // only postings this sync made (response_code ACCOUNTS) are flagged; manual postings from before are left alone
      const mine = await queryOne<any>(`SELECT response_code FROM trx_bill_posting WHERE id = ?`, [p.id]);
      if (mine?.response_code !== 'ACCOUNTS') continue;
      await transaction(async (tx) => {
        await txExecute(tx, `UPDATE trx_bill_posting SET status = 'RECON_REQUIRED', last_error_code = 'ACCOUNTS', last_error_summary = ?, row_version = row_version + 1 WHERE id = ?`,
          [`Accounts voucher of ${gone} was reversed / cancelled — check and re-post`.slice(0, 500), p.id]);
        await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, reason) VALUES (?,?,'ACCOUNTS_SYNC','RECON_REQUIRED',?)`,
          [p.id, Number(p.attempts) + 1, `Voucher of ${gone} no longer posted`.slice(0, 255)]);
        await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'RECON_REQUIRED', row_version = row_version + 1 WHERE id = ?`, [p.bill_id]);
      });
      recon += 1;
    }
  }
  return { posted, recon };
}
