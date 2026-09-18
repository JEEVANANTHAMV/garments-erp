-- =============================================================================
-- Migration 32: Buyer IO Prefix & Bills Inward classification
-- Adds io_prefix to mst_party for buyer-based Internal Order auto-generation
-- Adds bill_type and process references to trx_supplier_bill for 7 inward bill types
-- =============================================================================

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_party' AND COLUMN_NAME = 'io_prefix');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_party ADD COLUMN io_prefix VARCHAR(30) NULL AFTER party_code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_supplier_bill' AND COLUMN_NAME = 'bill_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_supplier_bill ADD COLUMN bill_type ENUM(\'YARN_PURCHASE\',\'YARN_PROCESS\',\'FABRIC_PURCHASE\',\'FABRIC_PROCESS\',\'TRIMS_PURCHASE\',\'TRIMS_PROCESS\',\'GENERAL\') NOT NULL DEFAULT \'GENERAL\' AFTER bill_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_supplier_bill' AND COLUMN_NAME = 'knitting_order_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_supplier_bill ADD COLUMN knitting_order_id BIGINT UNSIGNED NULL AFTER grn_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_supplier_bill' AND COLUMN_NAME = 'fabric_process_order_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_supplier_bill ADD COLUMN fabric_process_order_id BIGINT UNSIGNED NULL AFTER knitting_order_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_supplier_bill' AND COLUMN_NAME = 'jobwork_order_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_supplier_bill ADD COLUMN jobwork_order_id BIGINT UNSIGNED NULL AFTER fabric_process_order_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
