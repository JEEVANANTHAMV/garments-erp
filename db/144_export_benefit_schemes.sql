-- =====================================================================
-- 144 · Export benefits: configurable schemes + dated events (client voice note 24-Oct-2026 + the two specs
--       "Export Benefits Receipt Tracking" v1 and "Configurable Schemes" v2)
--   Drawback, IGST refund, RoDTEP and RoSCTL of a shipping bill come on different dates (the bank credits any time;
--   RoDTEP / RoSCTL come as e-scrips, sometimes late), and future benefits must be addable without code. So:
--   1. Scheme master (mst_export_benefit_scheme): code (immutable after use), name, category, tracking mode
--      CASH / SCRIP / NON_CASH / HYBRID, allowed events, required documents, custom fields (JSON, validated by the
--      server), settlement + ageing basis, order-profitability policy, active flag, config version (+ history).
--      The six old incentive types stay as the scheme codes, so existing claims keep working.
--   2. Claims (trx_export_incentive, one row per shipping bill + scheme): declared / claimed / approved amounts and
--      dates, applicability (Not applicable needs a reason), claim stage, derived status and balances.
--   3. Events (trx_export_benefit_event): bank receipt, refund credit, scrip issue / utilisation / sale, sale proceeds,
--      transfers, expiry, adjustment, reversal, claim filed, approval — each with its actual date, separate from the
--      ERP entry / posting time. Posted events are never deleted (reversed instead). The receipts of migration 142
--      move here once (BANK → BANK_RECEIPT, SCRIP → SCRIP_ISSUE: an e-scrip is not cash, ADJUSTED → ADJUSTMENT).
--   4. Status history, follow-ups, documents (served only through an authenticated route), bank statement lines +
--      reconciliation matches (one bank line can never be allocated twice).
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mst_export_benefit_scheme (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id           BIGINT UNSIGNED NOT NULL,
  code                 VARCHAR(40) NOT NULL COMMENT 'Stable code — immutable once used, never reused',
  display_name         VARCHAR(120) NOT NULL,
  short_name           VARCHAR(30) NULL COMMENT 'Compact label for grids (DBK, IGST …)',
  description          VARCHAR(1000) NULL,
  category             VARCHAR(30) NOT NULL DEFAULT 'OTHER' COMMENT 'CASH_REFUND / DUTY_DRAWBACK / SCRIP / CREDIT / REBATE / OTHER',
  tracking_mode        VARCHAR(10) NOT NULL DEFAULT 'CASH' COMMENT 'CASH / SCRIP / NON_CASH / HYBRID',
  default_currency     CHAR(3) NOT NULL DEFAULT 'INR',
  effective_from       DATE NULL,
  effective_to         DATE NULL,
  default_status       VARCHAR(20) NOT NULL DEFAULT 'ENTERED' COMMENT 'Initial claim stage',
  allowed_events       JSON NULL COMMENT '["BANK_RECEIPT", …]',
  required_documents   JSON NULL COMMENT '[{doc_type,label,stage,policy WARN|BLOCK}]',
  custom_fields        JSON NULL COMMENT '[{key,label,type,required,applies_to CLAIM|EVENT,options,min,max,max_length,pattern,event_types}]',
  settlement_basis     VARCHAR(12) NOT NULL DEFAULT 'DECLARED' COMMENT 'DECLARED / CLAIMED / APPROVED',
  ageing_basis         VARCHAR(12) NOT NULL DEFAULT 'SB_DATE' COMMENT 'SB_DATE / LEO_DATE / CLAIM_FILED / APPROVAL',
  profitability_policy VARCHAR(16) NOT NULL DEFAULT 'EXCLUDE' COMMENT 'EXCLUDE / ACCRUE_BASIS / REALISED_ONLY / APPROVED_ONLY',
  ledger_account_id    BIGINT UNSIGNED NULL COMMENT 'Finance mapping (informational; no second ledger)',
  sb_field             VARCHAR(30) NULL COMMENT 'Shipping bill column it is entered in (the 4 customs fields)',
  is_suggested         TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Shown as a suggested row on the shipping bill',
  allow_multiple       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'More than one claim of this scheme per shipping bill',
  sort_order           INT NOT NULL DEFAULT 100,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  config_version       INT NOT NULL DEFAULT 1,
  created_by           BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           BIGINT UNSIGNED NULL,
  updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ebs_code (company_id, code),
  KEY ix_ebs_active (company_id, is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Export benefit scheme master (configurable)';

CREATE TABLE IF NOT EXISTS log_export_benefit_scheme (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  scheme_id      BIGINT UNSIGNED NOT NULL,
  config_version INT NOT NULL,
  change_type    VARCHAR(16) NOT NULL COMMENT 'CREATE / UPDATE / MODE_CHANGE / ACTIVATE / DEACTIVATE',
  snapshot       JSON NOT NULL COMMENT 'Full configuration of this version',
  old_snapshot   JSON NULL,
  reason         VARCHAR(500) NULL,
  changed_by     BIGINT UNSIGNED NULL,
  changed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_lebs_scheme (scheme_id, config_version),
  CONSTRAINT fk_lebs__scheme FOREIGN KEY (scheme_id) REFERENCES mst_export_benefit_scheme (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Scheme configuration history (one row per version / activation change)';

-- the current schemes, once per company (the codes are the old incentive types, so existing claims map 1:1)
INSERT IGNORE INTO mst_export_benefit_scheme (company_id, code, display_name, short_name, description, category, tracking_mode, allowed_events, custom_fields,
       settlement_basis, ageing_basis, profitability_policy, sb_field, is_suggested, sort_order)
SELECT c.id, x.code, x.display_name, x.short_name, x.description, x.category, x.tracking_mode, CAST(x.allowed_events AS JSON), CAST(x.custom_fields AS JSON),
       'DECLARED', 'SB_DATE', x.policy, x.sb_field, x.suggested, x.sort_order
  FROM mst_company c
 CROSS JOIN (
  SELECT 'DUTY_DRAWBACK' code, 'Duty Drawback (DBK)' display_name, 'DBK' short_name, 'All-industry drawback credited by customs to the bank (scroll)' description,
         'DUTY_DRAWBACK' category, 'CASH' tracking_mode, '["CLAIM_FILED","APPROVAL","BANK_RECEIPT","ADJUSTMENT","REVERSAL"]' allowed_events,
         '[{"key":"scroll_no","label":"DBK scroll no","type":"text","required":false,"applies_to":"EVENT","event_types":["BANK_RECEIPT"],"max_length":40}]' custom_fields,
         'ACCRUE_BASIS' policy, 'drawback_amount' sb_field, 1 suggested, 10 sort_order
  UNION ALL SELECT 'GST_REFUND', 'IGST Refund', 'IGST', 'IGST paid on export goods, refunded by customs / GSTN to the bank', 'CASH_REFUND', 'CASH',
         '["CLAIM_FILED","APPROVAL","REFUND_CREDIT","BANK_RECEIPT","ADJUSTMENT","REVERSAL"]', '[]', 'EXCLUDE', 'igst_amount', 1, 20
  UNION ALL SELECT 'ROSCTL', 'RoSCTL', 'RoSCTL', 'Rebate of State and Central Taxes and Levies — issued as an e-scrip (ICEGATE ledger)', 'SCRIP', 'SCRIP',
         '["CLAIM_FILED","APPROVAL","SCRIP_ISSUE","SCRIP_UTILISATION","SCRIP_SALE","SALE_PROCEEDS","TRANSFER_IN","TRANSFER_OUT","EXPIRY","ADJUSTMENT","REVERSAL"]', '[]', 'ACCRUE_BASIS', 'rosctl_amount', 1, 30
  UNION ALL SELECT 'RODTEP', 'RoDTEP', 'RoDTEP', 'Remission of Duties and Taxes on Exported Products — issued as an e-scrip (ICEGATE ledger)', 'SCRIP', 'SCRIP',
         '["CLAIM_FILED","APPROVAL","SCRIP_ISSUE","SCRIP_UTILISATION","SCRIP_SALE","SALE_PROCEEDS","TRANSFER_IN","TRANSFER_OUT","EXPIRY","ADJUSTMENT","REVERSAL"]', '[]', 'ACCRUE_BASIS', 'rodtep_amount', 1, 40
  UNION ALL SELECT 'INTEREST_EQUAL', 'Interest Equalisation', 'IES', 'Interest equalisation on pre / post shipment credit (bank)', 'CREDIT', 'CASH',
         '["CLAIM_FILED","APPROVAL","BANK_RECEIPT","ADJUSTMENT","REVERSAL"]', '[]', 'EXCLUDE', NULL, 0, 50
  UNION ALL SELECT 'OTHER', 'Other Export Incentive', 'Other', 'Any other export incentive (legacy claims)', 'OTHER', 'CASH',
         '["CLAIM_FILED","APPROVAL","BANK_RECEIPT","ADJUSTMENT","REVERSAL"]', '[]', 'EXCLUDE', NULL, 0, 90
 ) x
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = c.id AND g.setting_key = 'EXPORT_BENEFIT_SCHEMES_SEEDED');
INSERT INTO log_export_benefit_scheme (company_id, scheme_id, config_version, change_type, snapshot, reason)
SELECT s.company_id, s.id, s.config_version, 'CREATE',
       JSON_OBJECT('code', s.code, 'display_name', s.display_name, 'short_name', s.short_name, 'description', s.description, 'category', s.category, 'tracking_mode', s.tracking_mode,
                   'default_currency', s.default_currency, 'effective_from', s.effective_from, 'effective_to', s.effective_to, 'default_status', s.default_status,
                   'allowed_events', s.allowed_events, 'required_documents', s.required_documents, 'custom_fields', s.custom_fields, 'settlement_basis', s.settlement_basis,
                   'ageing_basis', s.ageing_basis, 'profitability_policy', s.profitability_policy, 'ledger_account_id', s.ledger_account_id, 'sb_field', s.sb_field,
                   'is_suggested', s.is_suggested, 'allow_multiple', s.allow_multiple, 'sort_order', s.sort_order, 'is_active', s.is_active),
       'Seeded (migration 144)'
  FROM mst_export_benefit_scheme s
 WHERE NOT EXISTS (SELECT 1 FROM log_export_benefit_scheme l WHERE l.scheme_id = s.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EXPORT_BENEFIT_SCHEMES_SEEDED', '1', 'Export benefit schemes seeded (migration 144, one time)' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EXPORT_BENEFIT_DUP_REF_POLICY', 'WARN', 'Export benefit receipts: same bank UTR / reference already used — WARN (confirm to save) or BLOCK' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EXPORT_BENEFIT_TOLERANCE', '1', 'Export benefits: ₹ tolerance for "fully received / settled"' FROM mst_company;

-- ------------------------------------------------------------ claims: type is now the scheme code (any configured scheme)
SET @x = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_export_incentive' AND COLUMN_NAME='incentive_type');
SET @s = IF(@x = 'enum', 'ALTER TABLE trx_export_incentive MODIFY incentive_type VARCHAR(40) NOT NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
UPDATE trx_export_incentive SET status = 'PENDING' WHERE status IS NULL;   -- the old ENUM allowed NULL; the VARCHAR is NOT NULL
SET @x = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_export_incentive' AND COLUMN_NAME='status');
SET @s = IF(@x = 'enum', 'ALTER TABLE trx_export_incentive MODIFY status VARCHAR(20) NOT NULL DEFAULT ''PENDING'' COMMENT ''Legacy summary: PENDING / CLAIMED / PARTIAL / CREDITED / SHORT_CLOSED / REJECTED / NOT_APPLICABLE''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP PROCEDURE IF EXISTS _eb_add_col;
CREATE PROCEDURE _eb_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _eb_add_col('trx_export_incentive', 'scheme_id',             'BIGINT UNSIGNED NULL AFTER incentive_type');
CALL _eb_add_col('trx_export_incentive', 'scheme_config_version', 'INT NULL COMMENT ''Scheme configuration the claim was created / validated with''');
CALL _eb_add_col('trx_export_incentive', 'currency_code',         'CHAR(3) NOT NULL DEFAULT ''INR''');
CALL _eb_add_col('trx_export_incentive', 'declared_amount',       'DECIMAL(19,4) NULL COMMENT ''From the shipping bill / source (NULL = not known yet)''');
CALL _eb_add_col('trx_export_incentive', 'claimed_amount',        'DECIMAL(19,4) NULL');
CALL _eb_add_col('trx_export_incentive', 'claim_filed_date',      'DATE NULL');
CALL _eb_add_col('trx_export_incentive', 'approved_amount',       'DECIMAL(19,4) NULL');
CALL _eb_add_col('trx_export_incentive', 'approved_date',         'DATE NULL');
CALL _eb_add_col('trx_export_incentive', 'approval_ref',          'VARCHAR(120) NULL');
CALL _eb_add_col('trx_export_incentive', 'applicability',         'VARCHAR(16) NOT NULL DEFAULT ''APPLICABLE'' COMMENT ''APPLICABLE / NOT_APPLICABLE''');
CALL _eb_add_col('trx_export_incentive', 'not_applicable_reason', 'VARCHAR(500) NULL');
CALL _eb_add_col('trx_export_incentive', 'claim_stage',           'VARCHAR(16) NOT NULL DEFAULT ''ENTERED'' COMMENT ''ENTERED / FILED / QUERY / APPROVED / REJECTED / SHORT_CLOSED''');
CALL _eb_add_col('trx_export_incentive', 'benefit_status',        'VARCHAR(24) NULL COMMENT ''Derived from posted events + balances (NULL = to be recalculated)''');
CALL _eb_add_col('trx_export_incentive', 'basis_amount',          'DECIMAL(19,4) NULL COMMENT ''Settlement basis amount (declared / claimed / approved)''');
CALL _eb_add_col('trx_export_incentive', 'basis_source',          'VARCHAR(12) NULL COMMENT ''Which amount the basis came from''');
CALL _eb_add_col('trx_export_incentive', 'cash_received',         'DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Bank receipts + refund credits (posted, net of reversals)''');
CALL _eb_add_col('trx_export_incentive', 'sale_proceeds',         'DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Cash realised from scrip sale''');
CALL _eb_add_col('trx_export_incentive', 'adjusted_amount',       'DECIMAL(19,4) NOT NULL DEFAULT 0');
CALL _eb_add_col('trx_export_incentive', 'scrip_issued',          'DECIMAL(19,4) NOT NULL DEFAULT 0');
CALL _eb_add_col('trx_export_incentive', 'scrip_available',       'DECIMAL(19,4) NOT NULL DEFAULT 0');
CALL _eb_add_col('trx_export_incentive', 'scrip_utilised',        'DECIMAL(19,4) NOT NULL DEFAULT 0');
CALL _eb_add_col('trx_export_incentive', 'scrip_sold',            'DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Sold + transferred out (face value)''');
CALL _eb_add_col('trx_export_incentive', 'scrip_expired',         'DECIMAL(19,4) NOT NULL DEFAULT 0');
CALL _eb_add_col('trx_export_incentive', 'pending_amount',        'DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Basis − (cash + adjusted + scrip issued), 0 once closed''');
CALL _eb_add_col('trx_export_incentive', 'excess_amount',         'DECIMAL(19,4) NOT NULL DEFAULT 0 COMMENT ''Over-receipt (exception, never hidden)''');
CALL _eb_add_col('trx_export_incentive', 'last_event_date',       'DATE NULL');
CALL _eb_add_col('trx_export_incentive', 'ageing_date',           'DATE NULL COMMENT ''Date pending is aged from (scheme ageing basis)''');
CALL _eb_add_col('trx_export_incentive', 'custom_field_values',   'JSON NULL');
CALL _eb_add_col('trx_export_incentive', 'updated_by',            'BIGINT UNSIGNED NULL');
CALL _eb_add_col('trx_export_incentive', 'row_version',           'INT NOT NULL DEFAULT 1');
DROP PROCEDURE IF EXISTS _eb_add_col;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_export_incentive' AND INDEX_NAME='ix_inc_scheme_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_export_incentive ADD KEY ix_inc_scheme_status (company_id, scheme_id, benefit_status), ADD KEY ix_inc_filed (company_id, claim_filed_date)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- claims made before: their scheme + declared amount + stage (once — scheme_id is set from then on)
UPDATE trx_export_incentive x
  JOIN mst_export_benefit_scheme s ON s.company_id = x.company_id AND s.code = x.incentive_type
   SET x.scheme_id = s.id, x.scheme_config_version = s.config_version, x.declared_amount = x.claim_amount,
       x.claim_stage = CASE x.status WHEN 'REJECTED' THEN 'REJECTED' WHEN 'SHORT_CLOSED' THEN 'SHORT_CLOSED' ELSE 'ENTERED' END,
       x.benefit_status = NULL
 WHERE x.scheme_id IS NULL;

-- ------------------------------------------------------------ events
CREATE TABLE IF NOT EXISTS trx_export_benefit_event (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id          BIGINT UNSIGNED NOT NULL,
  claim_id            BIGINT UNSIGNED NOT NULL COMMENT 'trx_export_incentive',
  event_type          VARCHAR(24) NOT NULL COMMENT 'BANK_RECEIPT / REFUND_CREDIT / SCRIP_ISSUE / SCRIP_UTILISATION / SCRIP_SALE / SALE_PROCEEDS / TRANSFER_IN / TRANSFER_OUT / EXPIRY / ADJUSTMENT / REVERSAL / CLAIM_FILED / APPROVAL',
  event_date          DATE NOT NULL COMMENT 'Actual date (bank credit / scrip issue …), not the entry date',
  amount              DECIMAL(19,4) NOT NULL,
  currency_code       CHAR(3) NOT NULL DEFAULT 'INR',
  exchange_rate       DECIMAL(18,6) NOT NULL DEFAULT 1,
  rate_date           DATE NULL,
  base_amount         DECIMAL(19,4) NOT NULL COMMENT 'Amount in ₹',
  bank_account_id     BIGINT UNSIGNED NULL,
  bank_reference      VARCHAR(120) NULL COMMENT 'UTR / bank reference',
  scrip_number        VARCHAR(120) NULL,
  source_document_no  VARCHAR(120) NULL,
  reverses_event_id   BIGINT UNSIGNED NULL,
  reversed_by_event_id BIGINT UNSIGNED NULL,
  status              VARCHAR(10) NOT NULL DEFAULT 'DRAFT' COMMENT 'DRAFT / POSTED / REVERSED',
  is_exception        TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Posted under an authorised exception (over-receipt, early date, inactive scheme, duplicate ref)',
  exception_reason    VARCHAR(500) NULL,
  custom_field_values JSON NULL,
  remarks             VARCHAR(1000) NULL,
  scheme_config_version INT NULL,
  legacy_receipt_id   BIGINT UNSIGNED NULL COMMENT 'trx_export_incentive_receipt it was migrated from',
  created_by          BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_by           BIGINT UNSIGNED NULL,
  posted_at           DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ebe_legacy (legacy_receipt_id),
  KEY ix_ebe_claim (claim_id, status, event_date),
  KEY ix_ebe_date (company_id, event_date),
  KEY ix_ebe_ref (company_id, bank_reference),
  KEY ix_ebe_scrip (company_id, scrip_number),
  CONSTRAINT fk_ebe__claim FOREIGN KEY (claim_id) REFERENCES trx_export_incentive (id),
  CONSTRAINT fk_ebe__company FOREIGN KEY (company_id) REFERENCES mst_company (id),
  CONSTRAINT fk_ebe__bank FOREIGN KEY (bank_account_id) REFERENCES mst_company_bank_account (id),
  CONSTRAINT fk_ebe__rev FOREIGN KEY (reverses_event_id) REFERENCES trx_export_benefit_event (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Dated export benefit events (receipts, scrip lifecycle, reversals)';

-- the receipts of migration 142 become posted events, exactly once (an e-scrip is a scrip issue, not cash)
INSERT INTO trx_export_benefit_event (company_id, claim_id, event_type, event_date, amount, currency_code, exchange_rate, base_amount, bank_reference, scrip_number,
       status, remarks, scheme_config_version, legacy_receipt_id, created_by, created_at, posted_by, posted_at)
SELECT r.company_id, r.incentive_id, CASE r.mode WHEN 'SCRIP' THEN 'SCRIP_ISSUE' WHEN 'ADJUSTED' THEN 'ADJUSTMENT' ELSE 'BANK_RECEIPT' END,
       r.receipt_date, r.amount, 'INR', 1, r.amount, IF(r.mode = 'SCRIP', NULL, r.reference), IF(r.mode = 'SCRIP', r.reference, NULL),
       'POSTED', COALESCE(r.remarks, 'Migrated receipt'), x.scheme_config_version, r.id, r.created_by, r.created_at, r.created_by, r.created_at
  FROM trx_export_incentive_receipt r JOIN trx_export_incentive x ON x.id = r.incentive_id
 WHERE NOT EXISTS (SELECT 1 FROM trx_export_benefit_event e WHERE e.legacy_receipt_id = r.id);
-- ------------------------------------------------------------ status history, follow-ups, documents
CREATE TABLE IF NOT EXISTS log_export_benefit_status (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id  BIGINT UNSIGNED NOT NULL,
  claim_id    BIGINT UNSIGNED NOT NULL,
  old_status  VARCHAR(24) NULL,
  new_status  VARCHAR(24) NOT NULL,
  reason      VARCHAR(500) NULL,
  event_id    BIGINT UNSIGNED NULL,
  changed_by  BIGINT UNSIGNED NULL,
  changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_lebst_claim (claim_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Export benefit claim status history';

CREATE TABLE IF NOT EXISTS trx_export_benefit_followup (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  claim_id      BIGINT UNSIGNED NOT NULL,
  reason_code   VARCHAR(16) NOT NULL DEFAULT 'FOLLOW_UP' COMMENT 'FOLLOW_UP / QUERY / REJECTED / DELAY',
  action_note   VARCHAR(500) NOT NULL,
  owner_user_id BIGINT UNSIGNED NULL,
  due_date      DATE NULL,
  status        VARCHAR(8) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / DONE',
  done_note     VARCHAR(500) NULL,
  done_by       BIGINT UNSIGNED NULL,
  done_at       DATETIME NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_ebf_open (company_id, status, due_date),
  KEY ix_ebf_claim (claim_id),
  CONSTRAINT fk_ebf__claim FOREIGN KEY (claim_id) REFERENCES trx_export_incentive (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Export benefit follow-ups (query / rejection / delay)';

CREATE TABLE IF NOT EXISTS trx_export_benefit_document (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  claim_id      BIGINT UNSIGNED NOT NULL,
  event_id      BIGINT UNSIGNED NULL,
  doc_type      VARCHAR(40) NOT NULL DEFAULT 'OTHER',
  storage_key   VARCHAR(80) NOT NULL COMMENT 'Random file name under uploads/export-benefits (served only through the API)',
  original_name VARCHAR(200) NOT NULL,
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    INT UNSIGNED NOT NULL DEFAULT 0,
  is_deleted    TINYINT(1) NOT NULL DEFAULT 0,
  uploaded_by   BIGINT UNSIGNED NULL,
  uploaded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ebd_key (storage_key),
  KEY ix_ebd_claim (claim_id, is_deleted),
  CONSTRAINT fk_ebd__claim FOREIGN KEY (claim_id) REFERENCES trx_export_incentive (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Export benefit evidence (bank advice, scrip ledger, sanction …)';

-- ------------------------------------------------------------ bank statement + reconciliation
CREATE TABLE IF NOT EXISTS trx_export_benefit_bank_import (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  bank_account_id BIGINT UNSIGNED NULL,
  file_name       VARCHAR(200) NOT NULL,
  lines_read      INT NOT NULL DEFAULT 0,
  lines_new       INT NOT NULL DEFAULT 0,
  imported_by     BIGINT UNSIGNED NULL,
  imported_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_ebbi_company (company_id, imported_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bank statement imports (export benefit reconciliation)';

CREATE TABLE IF NOT EXISTS trx_export_benefit_bank_line (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  import_id       BIGINT UNSIGNED NULL,
  bank_account_id BIGINT UNSIGNED NULL,
  txn_date        DATE NOT NULL,
  amount          DECIMAL(19,4) NOT NULL COMMENT 'Credit amount',
  reference       VARCHAR(120) NULL COMMENT 'UTR / cheque / reference',
  narration       VARCHAR(500) NULL,
  line_hash       CHAR(40) NOT NULL COMMENT 'Idempotency: the same statement line is imported once',
  matched_amount  DECIMAL(19,4) NOT NULL DEFAULT 0,
  match_status    VARCHAR(10) NOT NULL DEFAULT 'UNMATCHED' COMMENT 'UNMATCHED / PARTIAL / MATCHED / IGNORED',
  ignore_reason   VARCHAR(300) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ebbl_hash (company_id, line_hash),
  KEY ix_ebbl_status (company_id, match_status, txn_date),
  KEY ix_ebbl_ref (company_id, reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bank statement credit lines to reconcile with benefit receipts';

CREATE TABLE IF NOT EXISTS trx_export_benefit_recon_match (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id     BIGINT UNSIGNED NOT NULL,
  bank_line_id   BIGINT UNSIGNED NOT NULL,
  event_id       BIGINT UNSIGNED NOT NULL,
  matched_amount DECIMAL(19,4) NOT NULL,
  match_type     VARCHAR(8) NOT NULL DEFAULT 'MANUAL' COMMENT 'AUTO / MANUAL',
  reason         VARCHAR(300) NULL COMMENT 'Required for a manual match whose reference / amount differs',
  status         VARCHAR(8) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / UNDONE',
  matched_by     BIGINT UNSIGNED NULL,
  matched_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  undone_by      BIGINT UNSIGNED NULL,
  undone_at      DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_ebrm_line (bank_line_id, status),
  KEY ix_ebrm_event (event_id, status),
  CONSTRAINT fk_ebrm__line FOREIGN KEY (bank_line_id) REFERENCES trx_export_benefit_bank_line (id),
  CONSTRAINT fk_ebrm__event FOREIGN KEY (event_id) REFERENCES trx_export_benefit_event (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Bank line ↔ benefit receipt matches';

-- ------------------------------------------------------------ permissions
--   EXPORT_BENEFIT.ADMIN   scheme master (roles holding both EXPORT.APPROVE and FINANCE.UPDATE)
--   EXPORT_BENEFIT.APPROVE reversals, exceptions (over-receipt, early date, inactive scheme), tracking-mode change
--                          (roles holding FINANCE.UPDATE). Cash / scrip events: FINANCE.UPDATE; SB + claims: EXPORT.*
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'EXPORT_BENEFIT.ADMIN', 'Export benefit scheme master (add / change / deactivate schemes)' FROM mst_module m
 WHERE m.module_code = 'EXPORT' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'EXPORT_BENEFIT.ADMIN');
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'EXPORT_BENEFIT.APPROVE', 'Export benefits: reverse posted events, approve exceptions and tracking-mode changes' FROM mst_module m
 WHERE m.module_code = 'FINANCE' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'EXPORT_BENEFIT.APPROVE');
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT a.role_id, p.id FROM map_role_permission a
  JOIN mst_role r ON r.id = a.role_id
  JOIN mst_permission pa ON pa.id = a.permission_id AND pa.permission_code = 'EXPORT.APPROVE'
  JOIN map_role_permission b ON b.role_id = a.role_id
  JOIN mst_permission pb ON pb.id = b.permission_id AND pb.permission_code = 'FINANCE.UPDATE'
  JOIN mst_permission p ON p.permission_code = 'EXPORT_BENEFIT.ADMIN'
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'EXPORT_BENEFIT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = a.role_id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT DISTINCT a.role_id, p.id FROM map_role_permission a
  JOIN mst_role r ON r.id = a.role_id
  JOIN mst_permission pa ON pa.id = a.permission_id AND pa.permission_code = 'FINANCE.UPDATE'
  JOIN mst_permission p ON p.permission_code = 'EXPORT_BENEFIT.APPROVE'
 WHERE NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'EXPORT_BENEFIT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = a.role_id AND m.permission_id = p.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'EXPORT_BENEFIT_PERMS_GRANTED', '1', 'EXPORT_BENEFIT.ADMIN / APPROVE granted (one time, migration 144)' FROM mst_company;
