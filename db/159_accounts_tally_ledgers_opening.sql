-- =====================================================================
-- 159 · Accounts: Tally ledger list + matching, bill-wise opening balances, bill tracker posts through Accounts (09-Nov-2026)
--   acc_tally_ledger    ledgers as they exist in the client's Tally (from a Tally masters XML / Excel file or fetched
--                       from the Tally server) — used to match ERP ledgers to Tally names so Tally never gets duplicates
--   acc_opening_bill    pending bills on the books-beginning date (party-wise, bill-wise) so outstanding / ageing start right
--   BT_POSTING_ADAPTER  = ACCOUNTS (once per company): a tracked bill is "posted" when Accounts posts the linked bill's
--                       voucher (sent to Tally from Accounts) — no second, manual entry of the same bill in Tally
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS acc_tally_ledger (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  tally_company_id BIGINT UNSIGNED NOT NULL,
  tally_name       VARCHAR(200) NOT NULL,
  parent_name      VARCHAR(200) NULL COMMENT 'Tally group (Under)',
  gstin            VARCHAR(15) NULL,
  opening_balance  DECIMAL(19,2) NULL COMMENT 'Signed, Dr + (Tally stores Dr as negative — converted on import)',
  bills_json       JSON NULL COMMENT 'Bill-wise opening allocations from Tally [{name, date, due, amount (Dr +)}]',
  source           VARCHAR(10) NOT NULL DEFAULT 'FILE' COMMENT 'FILE / FETCH',
  imported_by      BIGINT UNSIGNED NULL,
  imported_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acctl (tally_company_id, tally_name),
  KEY ix_acctl_co (company_id)
) ENGINE=InnoDB COMMENT='Accounts: ledgers that exist in the client''s Tally company';

CREATE TABLE IF NOT EXISTS acc_opening_bill (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  ledger_id        BIGINT UNSIGNED NOT NULL,
  bill_ref_no      VARCHAR(60) NOT NULL,
  bill_date        DATE NULL,
  due_date         DATE NULL,
  amount           DECIMAL(19,2) NOT NULL COMMENT 'Signed, Dr + (receivable) / Cr − (payable)',
  remarks          VARCHAR(200) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accob (ledger_id, bill_ref_no),
  KEY ix_accob_co (company_id)
) ENGINE=InnoDB COMMENT='Accounts: bill-wise opening balances (pending bills on the books-beginning date)';

-- bill tracker → Accounts (one time per company; a later manual change of the setting is kept)
INSERT INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, 'BT_POSTING_ADAPTER', 'ACCOUNTS', 'Bill tracker posting: ACCOUNTS = posted when the Accounts module posts the linked bill''s voucher; MANUAL = voucher no typed in'
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'ACC_BT_ADAPTER_SET')
ON DUPLICATE KEY UPDATE setting_value = 'ACCOUNTS';
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ACC_BT_ADAPTER_SET', '1', 'Bill tracker switched to post through Accounts (one time, migration 159)' FROM mst_company;
