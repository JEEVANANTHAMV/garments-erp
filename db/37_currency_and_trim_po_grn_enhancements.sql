-- =============================================================================
-- Migration 37: Currency, Import PO, Trim Procurement & General GRN Numbering
-- =============================================================================

-- 1. trx_trim_po: currency_id, exchange_rate
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN currency_id SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER supplier_id, ADD CONSTRAINT fk_tpo__currency FOREIGN KEY (currency_id) REFERENCES cfg_currency(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_po' AND COLUMN_NAME = 'exchange_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_po ADD COLUMN exchange_rate DECIMAL(12,4) NOT NULL DEFAULT 1.0000 AFTER currency_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. trx_trim_grn: currency_id, exchange_rate
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'currency_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN currency_id SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER supplier_id, ADD CONSTRAINT fk_tgrn__currency FOREIGN KEY (currency_id) REFERENCES cfg_currency(id)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_trim_grn' AND COLUMN_NAME = 'exchange_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_trim_grn ADD COLUMN exchange_rate DECIMAL(12,4) NOT NULL DEFAULT 1.0000 AFTER currency_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. trx_general_purchase: grn_no
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_general_purchase' AND COLUMN_NAME = 'grn_no');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_general_purchase ADD COLUMN grn_no VARCHAR(40) NULL AFTER purchase_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Number series for General GRN if missing
INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
SELECT c.id, NULL, 'GENERAL_GRN', NULL, 'GGRN-', 1, 6
FROM mst_company c
WHERE NOT EXISTS (
  SELECT 1 FROM cfg_number_series s WHERE s.company_id = c.id AND s.doc_type = 'GENERAL_GRN'
);
