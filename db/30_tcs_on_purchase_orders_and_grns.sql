-- =============================================================================
-- Migration 30: TCS on Purchase Orders & GRNs
-- Adds tcs_applicable, tcs_section, tcs_rate, tcs_amount and freight/other/
-- round_off to trx_purchase_order; same for trx_grn.
-- Safe idempotent pattern (IF NOT EXISTS check).
-- =============================================================================

-- ---- trx_purchase_order: taxable_amount (header level) ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'taxable_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN taxable_amount DECIMAL(18,4) DEFAULT 0 AFTER total_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: freight_charges ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'freight_charges');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN freight_charges DECIMAL(18,4) DEFAULT 0 AFTER igst_amount', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: other_charges ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'other_charges');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN other_charges DECIMAL(18,4) DEFAULT 0 AFTER freight_charges', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: round_off ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'round_off');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN round_off DECIMAL(10,4) DEFAULT 0 AFTER other_charges', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: tcs_applicable ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'tcs_applicable');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN tcs_applicable TINYINT(1) NOT NULL DEFAULT 0 AFTER round_off', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: tcs_section ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'tcs_section');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN tcs_section VARCHAR(30) NULL AFTER tcs_applicable', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: tcs_rate ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'tcs_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN tcs_rate DECIMAL(6,4) DEFAULT 0 AFTER tcs_section', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_purchase_order: tcs_amount ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order' AND COLUMN_NAME = 'tcs_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order ADD COLUMN tcs_amount DECIMAL(18,4) DEFAULT 0 AFTER tcs_rate', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- =============================================================================
-- trx_grn: add freight_charges, other_charges, round_off, tcs_*, grand_total
-- =============================================================================

-- ---- trx_grn: freight_charges ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'freight_charges');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN freight_charges DECIMAL(18,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: other_charges ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'other_charges');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN other_charges DECIMAL(18,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: round_off ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'round_off');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN round_off DECIMAL(10,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: tcs_applicable ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'tcs_applicable');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN tcs_applicable TINYINT(1) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: tcs_section ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'tcs_section');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN tcs_section VARCHAR(30) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: tcs_rate ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'tcs_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN tcs_rate DECIMAL(6,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: tcs_amount ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'tcs_amount');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN tcs_amount DECIMAL(18,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- trx_grn: grand_total ----
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn' AND COLUMN_NAME = 'grand_total');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn ADD COLUMN grand_total DECIMAL(18,4) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
