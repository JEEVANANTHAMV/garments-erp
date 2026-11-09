-- =====================================================================
-- 158 · Accounts module: permissions, posting issues, bank realisation fields (client voice note 09-Nov-2026)
--   ACCOUNTS.VIEW     books, vouchers, reports
--   ACCOUNTS.ENTRY    create / edit / submit manual vouchers, bank realisation, scan documents into vouchers
--   ACCOUNTS.APPROVE  approve (post) / reject vouchers, reverse posted vouchers (maker-checker: not your own voucher)
--   ACCOUNTS.ADMIN    groups, ledgers, posting ledgers, posting switches, period lock, Tally company set-up
--   ACCOUNTS.TALLY    Tally posting monitor: export XML, mark posted / failed, retry
--   Granted once to SUPER_ADMIN / ADMIN / ACCOUNTANT / ALL_RIGHTS (all), and VIEW to roles holding FINANCE.VIEW.
-- Bank realisation reuses trx_receipt (+ map_receipt_invoice) so the existing export realisation report keeps working.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

INSERT INTO mst_module (module_code, module_name, parent_id, sort_order)
SELECT 'ACCOUNTS', 'Accounts (books & Tally)', (SELECT id FROM (SELECT id FROM mst_module WHERE module_code = 'FINANCE') x), 101
 WHERE NOT EXISTS (SELECT 1 FROM mst_module WHERE module_code = 'ACCOUNTS');
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'ACCOUNTS.VIEW' code, 'View books: vouchers, ledgers, trial balance, P&L, balance sheet, outstanding' name UNION ALL
        SELECT 'ACCOUNTS.ENTRY', 'Enter / submit vouchers, bank realisation, create vouchers from ERP documents' UNION ALL
        SELECT 'ACCOUNTS.APPROVE', 'Approve (post) / reject / reverse vouchers (maker-checker)' UNION ALL
        SELECT 'ACCOUNTS.ADMIN', 'Accounts set-up: groups, ledgers, posting ledgers, posting switches, period lock, Tally company' UNION ALL
        SELECT 'ACCOUNTS.TALLY', 'Tally posting monitor: export XML, mark posted / failed, retry') t
 WHERE m.module_code = 'ACCOUNTS' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code LIKE 'ACCOUNTS.%'
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'ALL_RIGHTS')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'ACC_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT r.id, p.id FROM mst_role r
  JOIN map_role_permission rp ON rp.role_id = r.id
  JOIN mst_permission fv ON fv.id = rp.permission_id AND fv.permission_code = 'FINANCE.VIEW'
  JOIN mst_permission p ON p.permission_code = 'ACCOUNTS.VIEW'
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'ACC_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ACC_PERMS_GRANTED', '1', 'Accounts permissions granted to the standard roles (one time, migration 158)' FROM mst_company;

-- Documents that could not be turned into a voucher (missing ledger mapping, totals that do not add up …)
CREATE TABLE IF NOT EXISTS acc_posting_issue (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  event_code       VARCHAR(40) NOT NULL,
  source_id        BIGINT UNSIGNED NOT NULL,
  source_no        VARCHAR(60) NULL,
  source_date      DATE NULL,
  error_code       VARCHAR(30) NULL COMMENT 'MAPPING / DATA / LOCKED / OTHER',
  message          VARCHAR(1000) NOT NULL,
  attempts         INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accpi (company_id, event_code, source_id)
) ENGINE=InnoDB COMMENT='Accounts: documents waiting for a voucher that failed (fix the cause, then Scan again)';

-- Bank realisation on trx_receipt
DROP PROCEDURE IF EXISTS _a158_add_col;
CREATE PROCEDURE _a158_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(600))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl); PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _a158_add_col('trx_receipt', 'bank_account_id', 'BIGINT UNSIGNED NULL COMMENT ''Our bank account credited (mst_company_bank_account)''');
CALL _a158_add_col('trx_receipt', 'bank_charges_inr', 'DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT ''Bank / foreign bank charges deducted (INR)''');
CALL _a158_add_col('trx_receipt', 'firc_no', 'VARCHAR(60) NULL COMMENT ''FIRC / e-BRC reference''');
CALL _a158_add_col('trx_receipt', 'status', 'VARCHAR(12) NOT NULL DEFAULT ''POSTED'' COMMENT ''DRAFT / POSTED / CANCELLED''');
CALL _a158_add_col('trx_receipt', 'cancel_reason', 'VARCHAR(300) NULL');
CALL _a158_add_col('trx_receipt', 'updated_by', 'BIGINT UNSIGNED NULL');
CALL _a158_add_col('trx_receipt', 'updated_at', 'DATETIME NULL');
DROP PROCEDURE IF EXISTS _a158_add_col;
