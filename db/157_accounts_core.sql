-- =====================================================================
-- 157 · Accounts module core (spec: Complete_Accounts_TallyPrime_Developer_Document.docx, client voice note 09-Nov-2026)
--   "Build the accounts module so our accounts team can enter and check entries now; the Tally API comes later
--    and is added in parallel."
--
--   acc_account_group   Tally-style group tree (the 28 Tally predefined groups are seeded per company)
--   acc_ledger          ledgers; party ledgers link mst_party (bill-wise), bank ledgers link mst_company_bank_account
--   acc_ledger_role     posting role → ledger (PURCHASE_YARN, INPUT_IGST, EXPORT_SALES …) — the auto-posting map
--   acc_voucher_type    Journal / Payment / Receipt / Contra / Sales / Purchase / Debit Note / Credit Note
--   acc_voucher(+entry) balanced vouchers; posted vouchers are immutable (correct by reversal)
--   acc_cost_centre     job / style / buyer / department / process dimensions
--   acc_period_lock     books locked up to a date
--   acc_posting_rule    per source event: OFF / REVIEW (voucher waits for accounts approval) / AUTO (posted at once)
--   acc_tally_*         destination company, master mapping, posting queue, attempt log
--
-- Money is DECIMAL(19,4) / (19,2), never FLOAT. No foreign keys to source documents (posting is by source_module + id).
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS acc_account_group (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  group_code       VARCHAR(30) NOT NULL,
  group_name       VARCHAR(100) NOT NULL,
  parent_id        BIGINT UNSIGNED NULL,
  nature           ENUM('ASSET','LIABILITY','INCOME','EXPENSE') NOT NULL,
  affects_gross_profit TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = trading account (direct income / expense, purchases, sales)',
  sort_order       INT NOT NULL DEFAULT 0,
  is_system        TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Tally predefined group: cannot be renamed into another nature or deleted',
  tally_name       VARCHAR(100) NULL COMMENT 'Group name in Tally (blank = same as group_name)',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accgrp_code (company_id, group_code),
  UNIQUE KEY uq_accgrp_name (company_id, group_name),
  KEY ix_accgrp_parent (parent_id)
) ENGINE=InnoDB COMMENT='Accounts: account group tree (Tally groups)';

CREATE TABLE IF NOT EXISTS acc_ledger (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  ledger_code      VARCHAR(40) NOT NULL,
  ledger_name      VARCHAR(150) NOT NULL,
  group_id         BIGINT UNSIGNED NOT NULL,
  ledger_type      VARCHAR(20) NOT NULL DEFAULT 'GENERAL' COMMENT 'GENERAL / PARTY / BANK / CASH / TAX / STOCK',
  party_id         BIGINT UNSIGNED NULL COMMENT 'Party ledger (Sundry Debtors / Creditors) — one ledger per party',
  bank_account_id  BIGINT UNSIGNED NULL COMMENT 'Bank ledger ↔ mst_company_bank_account',
  is_bill_wise     TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Track bill-wise (new ref / against ref / advance / on account)',
  is_control       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Control account (GRNI, round off, tax): no manual vouchers unless allowed',
  is_cost_centre_on TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Lines on this ledger can carry a cost centre / job',
  tax_kind         VARCHAR(20) NULL COMMENT 'TAX ledgers: CGST / SGST / IGST / CESS / TDS / TCS',
  tax_direction    VARCHAR(6) NULL COMMENT 'IN (input credit) / OUT (output liability)',
  tax_rate         DECIMAL(7,3) NULL COMMENT 'Informational (Tally duty ledger percentage)',
  gstin            VARCHAR(15) NULL,
  state_code       VARCHAR(2) NULL,
  currency_id      SMALLINT UNSIGNED NULL,
  opening_balance  DECIMAL(19,2) NOT NULL DEFAULT 0 COMMENT 'Opening balance at opening_date (positive amount)',
  opening_dr_cr    ENUM('DR','CR') NOT NULL DEFAULT 'DR',
  opening_date     DATE NULL COMMENT 'Books-beginning date of the opening balance',
  tally_name       VARCHAR(150) NULL COMMENT 'Ledger name in Tally (blank = same as ledger_name)',
  remarks          VARCHAR(300) NULL,
  is_system        TINYINT(1) NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accled_code (company_id, ledger_code),
  UNIQUE KEY uq_accled_name (company_id, ledger_name),
  UNIQUE KEY uq_accled_party (company_id, party_id),
  KEY ix_accled_group (group_id),
  CONSTRAINT fk_accled__group FOREIGN KEY (group_id) REFERENCES acc_account_group(id)
) ENGINE=InnoDB COMMENT='Accounts: ledger master';

CREATE TABLE IF NOT EXISTS acc_ledger_role (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  role_code        VARCHAR(40) NOT NULL,
  ledger_id        BIGINT UNSIGNED NULL COMMENT 'NULL = not mapped (auto-posting stops with a clear error)',
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accrole (company_id, role_code)
) ENGINE=InnoDB COMMENT='Accounts: posting role → ledger map (used by automatic vouchers)';

CREATE TABLE IF NOT EXISTS acc_voucher_type (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  type_code        VARCHAR(20) NOT NULL COMMENT 'JOURNAL / PAYMENT / RECEIPT / CONTRA / SALES / PURCHASE / DEBIT_NOTE / CREDIT_NOTE',
  type_name        VARCHAR(60) NOT NULL,
  prefix           VARCHAR(12) NOT NULL,
  tally_voucher_type VARCHAR(60) NOT NULL COMMENT 'Voucher type name in Tally',
  approval_required TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Manual vouchers: maker-checker (submit → approve by another user)',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_accvt (company_id, type_code)
) ENGINE=InnoDB COMMENT='Accounts: voucher types';

CREATE TABLE IF NOT EXISTS acc_voucher_counter (
  company_id       BIGINT UNSIGNED NOT NULL,
  fy_code          VARCHAR(12) NOT NULL,
  type_code        VARCHAR(20) NOT NULL,
  last_no          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, fy_code, type_code)
) ENGINE=InnoDB COMMENT='Accounts: voucher number counters per company / FY / type (numbers are given at posting, gap-free)';

CREATE TABLE IF NOT EXISTS acc_cost_centre (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  centre_code      VARCHAR(40) NOT NULL,
  centre_name      VARCHAR(150) NOT NULL,
  dimension_type   VARCHAR(20) NOT NULL DEFAULT 'OTHER' COMMENT 'JOB / STYLE / BUYER / DEPARTMENT / PROCESS / UNIT / OTHER',
  parent_id        BIGINT UNSIGNED NULL,
  so_id            BIGINT UNSIGNED NULL COMMENT 'JOB centre ↔ sales order (IO)',
  tally_name       VARCHAR(150) NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acccc (company_id, centre_code),
  KEY ix_acccc_so (company_id, so_id)
) ENGINE=InnoDB COMMENT='Accounts: cost centres';

CREATE TABLE IF NOT EXISTS acc_period_lock (
  company_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  locked_upto      DATE NULL COMMENT 'No voucher dated on/before this date may be posted, reversed or cancelled',
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='Accounts: books locked up to a date';

CREATE TABLE IF NOT EXISTS acc_voucher (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  fy_code          VARCHAR(12) NULL,
  type_code        VARCHAR(20) NOT NULL,
  voucher_no       VARCHAR(40) NULL COMMENT 'Given when posted (draft vouchers show DRAFT-<id>)',
  voucher_date     DATE NOT NULL,
  party_ledger_id  BIGINT UNSIGNED NULL COMMENT 'Main party of the voucher (for registers / Tally party name)',
  ref_no           VARCHAR(60) NULL COMMENT 'Supplier invoice no / buyer invoice no / UTR',
  ref_date         DATE NULL,
  narration        VARCHAR(1000) NULL,
  currency_code    VARCHAR(3) NULL COMMENT 'Transaction currency when not INR (export invoices / realisation)',
  exchange_rate    DECIMAL(18,6) NULL,
  fc_amount        DECIMAL(19,2) NULL COMMENT 'Document value in transaction currency',
  total_debit      DECIMAL(19,2) NOT NULL DEFAULT 0,
  total_credit     DECIMAL(19,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / PENDING_APPROVAL / POSTED / REJECTED / CANCELLED / REVERSED',
  is_auto          TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = generated from an ERP document',
  source_module    VARCHAR(40) NULL COMMENT 'SUPPLIER_BILL / COMMERCIAL_INVOICE / REALISATION / … (NULL = manual voucher)',
  source_id        BIGINT UNSIGNED NULL,
  source_no        VARCHAR(60) NULL,
  posting_event    VARCHAR(30) NULL COMMENT 'APPROVE / PAY / FINAL / REALISE …',
  source_revision  INT UNSIGNED NOT NULL DEFAULT 1,
  source_key       VARCHAR(160) NULL COMMENT 'Unique posting identity: module:event:id:rev — prevents double posting',
  reversal_of_id   BIGINT UNSIGNED NULL,
  reversed_by_id   BIGINT UNSIGNED NULL,
  reject_reason    VARCHAR(500) NULL,
  cancel_reason    VARCHAR(500) NULL,
  tally_status     VARCHAR(16) NOT NULL DEFAULT 'NOT_SENT' COMMENT 'NOT_SENT / PENDING / PROCESSING / POSTED / FAILED / UNKNOWN / RECONCILED / SKIPPED',
  tally_voucher_no VARCHAR(60) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  submitted_by     BIGINT UNSIGNED NULL,
  submitted_at     DATETIME NULL,
  approved_by      BIGINT UNSIGNED NULL,
  approved_at      DATETIME NULL,
  row_version      INT UNSIGNED NOT NULL DEFAULT 1,
  UNIQUE KEY uq_accv_no (company_id, type_code, fy_code, voucher_no),
  UNIQUE KEY uq_accv_source (company_id, source_key),
  KEY ix_accv_date (company_id, voucher_date),
  KEY ix_accv_status (company_id, status),
  KEY ix_accv_src (company_id, source_module, source_id),
  KEY ix_accv_tally (company_id, tally_status)
) ENGINE=InnoDB COMMENT='Accounts: voucher header (ERP books)';

CREATE TABLE IF NOT EXISTS acc_voucher_entry (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  voucher_id       BIGINT UNSIGNED NOT NULL,
  line_no          INT UNSIGNED NOT NULL,
  ledger_id        BIGINT UNSIGNED NOT NULL,
  debit            DECIMAL(19,2) NOT NULL DEFAULT 0,
  credit           DECIMAL(19,2) NOT NULL DEFAULT 0,
  fc_amount        DECIMAL(19,2) NULL COMMENT 'Line amount in transaction currency (export / realisation)',
  narration        VARCHAR(300) NULL,
  bill_ref_type    VARCHAR(12) NULL COMMENT 'Bill-wise: NEW / AGAINST / ADVANCE / ON_ACCOUNT',
  bill_ref_no      VARCHAR(60) NULL,
  bill_due_date    DATE NULL,
  cost_centre_id   BIGINT UNSIGNED NULL,
  so_id            BIGINT UNSIGNED NULL COMMENT 'Job / IO (sales order) for job-wise books',
  style_id         BIGINT UNSIGNED NULL,
  tax_kind         VARCHAR(20) NULL,
  tax_rate         DECIMAL(7,3) NULL,
  taxable_value    DECIMAL(19,2) NULL,
  hsn_code         VARCHAR(12) NULL,
  KEY ix_acce_v (voucher_id),
  KEY ix_acce_ledger (ledger_id),
  KEY ix_acce_bill (ledger_id, bill_ref_no),
  KEY ix_acce_so (so_id),
  CONSTRAINT fk_acce__voucher FOREIGN KEY (voucher_id) REFERENCES acc_voucher(id),
  CONSTRAINT fk_acce__ledger  FOREIGN KEY (ledger_id)  REFERENCES acc_ledger(id)
) ENGINE=InnoDB COMMENT='Accounts: voucher Dr / Cr lines';

CREATE TABLE IF NOT EXISTS acc_posting_rule (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  event_code       VARCHAR(40) NOT NULL COMMENT 'e.g. SUPPLIER_BILL.APPROVE, SUPPLIER_BILL.PAY, COMMERCIAL_INVOICE.FINAL, REALISATION.POST',
  mode             VARCHAR(8) NOT NULL DEFAULT 'REVIEW' COMMENT 'OFF / REVIEW (voucher waits for accounts approval) / AUTO (posted at once)',
  effective_from   DATE NULL COMMENT 'Documents dated before this are not posted automatically (use "Create voucher" from the pending list)',
  updated_by       BIGINT UNSIGNED NULL,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_accrule (company_id, event_code)
) ENGINE=InnoDB COMMENT='Accounts: automatic posting switches per source event';

-- --------------------------------------------------------------- Tally
CREATE TABLE IF NOT EXISTS acc_tally_company (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  tally_company_name VARCHAR(150) NOT NULL COMMENT 'Exact company name as loaded in Tally (SVCURRENTCOMPANY)',
  tally_company_guid VARCHAR(80) NULL,
  gstin            VARCHAR(15) NULL,
  fy_code          VARCHAR(12) NULL COMMENT 'Blank = all financial years',
  connector        VARCHAR(16) NOT NULL DEFAULT 'XML_FILE' COMMENT 'XML_FILE (download & import into Tally, voucher no entered back) / HTTP (Tally XML server) / API (vendor API)',
  host             VARCHAR(200) NULL,
  port             INT UNSIGNED NULL,
  secret_enc       TEXT NULL COMMENT 'Connector credential (secretBox, never sent to the browser)',
  timeout_ms       INT UNSIGNED NOT NULL DEFAULT 20000,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  last_health_at   DATETIME NULL,
  last_health_ok   TINYINT(1) NULL,
  last_health_msg  VARCHAR(300) NULL,
  updated_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acctc (company_id, tally_company_name)
) ENGINE=InnoDB COMMENT='Accounts: destination Tally company per ERP company';

CREATE TABLE IF NOT EXISTS acc_tally_queue (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  tally_company_id BIGINT UNSIGNED NOT NULL,
  voucher_id       BIGINT UNSIGNED NOT NULL,
  idempotency_key  VARCHAR(120) NOT NULL COMMENT 'company:voucher:tallyco:rev — retries reuse it',
  status           VARCHAR(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / PROCESSING / POSTED / FAILED / UNKNOWN / CANCELLED',
  attempts         INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at    DATETIME NULL,
  locked_at        DATETIME NULL,
  last_error_code  VARCHAR(40) NULL,
  last_error       VARCHAR(1000) NULL,
  tally_voucher_id VARCHAR(80) NULL,
  tally_voucher_no VARCHAR(60) NULL,
  tally_voucher_date DATE NULL,
  posted_at        DATETIME NULL,
  posted_by        BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_acctq_key (tally_company_id, idempotency_key),
  KEY ix_acctq_status (company_id, status, next_retry_at),
  KEY ix_acctq_voucher (voucher_id)
) ENGINE=InnoDB COMMENT='Accounts: Tally posting queue (one row per voucher per destination)';

CREATE TABLE IF NOT EXISTS acc_tally_log (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  queue_id         BIGINT UNSIGNED NOT NULL,
  action           VARCHAR(20) NOT NULL COMMENT 'SUBMIT / LOOKUP / MANUAL_POST / MARK_FAILED / RETRY / DOWNLOAD',
  outcome          VARCHAR(16) NULL,
  request_payload  MEDIUMTEXT NULL,
  response_payload MEDIUMTEXT NULL,
  http_status      INT NULL,
  duration_ms      INT UNSIGNED NULL,
  message          VARCHAR(1000) NULL,
  actor_id         BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_acctl_q (queue_id)
) ENGINE=InnoDB COMMENT='Accounts: Tally request / response log';

-- Default groups (the 28 Tally predefined groups), voucher types, system ledgers and posting roles are seeded per company
-- by server/src/modules/accounts/accountsSetup.ts (one source of truth; runs for every company incl. ones created later).
