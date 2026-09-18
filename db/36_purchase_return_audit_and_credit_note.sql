-- =============================================================================
-- Migration 36: Purchase Return audit trail (spec §28) and Credit Note (spec §27)
--
-- §28 requires a dedicated purchase_return_audits table recording every state
-- change with user, timestamp and IP.
-- §27 requires the financial reversal to be represented by a Credit Note rather
-- than by editing the GRN. The return header already carries credit_note_ref /
-- _date / _amount as reference fields; this adds the transaction itself.
-- =============================================================================

-- ----------------------------------------------------------------- §28 AUDIT
CREATE TABLE IF NOT EXISTS trx_purchase_return_audit (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  purchase_return_id BIGINT UNSIGNED NOT NULL,
  action             VARCHAR(40) NOT NULL,   -- CREATED, UPDATED, SUBMITTED, APPROVED,
                                             -- REJECTED, RETURN_DC_CREATED, STOCK_POSTED,
                                             -- CREDIT_NOTE_CREATED, CANCELLED
  old_status         VARCHAR(40) NULL,
  new_status         VARCHAR(40) NULL,
  user_id            BIGINT UNSIGNED NULL,
  ip_address         VARCHAR(64) NULL,
  remarks            VARCHAR(500) NULL,
  action_date        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pra_return (purchase_return_id),
  KEY ix_pra_action (action, action_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Purchase return audit trail (spec section 28)';

-- ----------------------------------------------------------- §27 CREDIT NOTE
CREATE TABLE IF NOT EXISTS trx_purchase_credit_note (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id         BIGINT UNSIGNED NOT NULL,
  credit_note_no     VARCHAR(40) NOT NULL,
  credit_note_date   DATE NOT NULL,
  purchase_return_id BIGINT UNSIGNED NOT NULL,
  supplier_id        BIGINT UNSIGNED NOT NULL,
  supplier_invoice_no VARCHAR(100) NULL,
  taxable_amount     DECIMAL(18,4) NOT NULL DEFAULT 0,
  cgst_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  sgst_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  igst_amount        DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_amount       DECIMAL(18,4) NOT NULL DEFAULT 0,
  status             VARCHAR(30) NOT NULL DEFAULT 'DRAFT',  -- DRAFT, ISSUED, ADJUSTED, CANCELLED
  adjusted_against   VARCHAR(100) NULL,
  remarks            VARCHAR(500) NULL,
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pcn (company_id, credit_note_no),
  KEY ix_pcn_return (purchase_return_id),
  KEY ix_pcn_supplier (supplier_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Supplier credit note raised against a purchase return (spec section 27)';

-- Number series for the credit note, created past any existing rows.
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, suffix, next_number, padding)
SELECT c.id, NULL, 'PURCHASE_CREDIT_NOTE', NULL, 'PCN-', '', 1, 5
  FROM mst_company c
 WHERE NOT EXISTS (
   SELECT 1 FROM cfg_number_series s
    WHERE s.company_id = c.id AND s.doc_type = 'PURCHASE_CREDIT_NOTE'
      AND s.branch_id IS NULL AND s.fy_id IS NULL
 );

-- Link column on the return header so the return knows its credit note.
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return' AND COLUMN_NAME = 'credit_note_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return ADD COLUMN credit_note_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
