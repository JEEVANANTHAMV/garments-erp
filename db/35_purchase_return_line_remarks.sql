-- =============================================================================
-- Migration 35: trx_purchase_return_line.remarks
--
-- purchaseReturn.routes.ts inserts a per-line `remarks` value (spec section 7
-- lists remarks as a Purchase Return Item field), but neither the base table in
-- 11_missing_features.sql nor migration 33 ever created the column, so creating
-- any purchase return failed with Unknown column 'remarks'.
-- =============================================================================

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_return_line' AND COLUMN_NAME = 'remarks');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_return_line ADD COLUMN remarks VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
