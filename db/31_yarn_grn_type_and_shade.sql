-- =============================================================================
-- Migration 31: Add yarn_type, shade_code to trx_grn_line
-- Ensures Yarn GRN preserves yarn classification (Grey/Dyed) and shade code.
-- =============================================================================

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'yarn_type');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN yarn_type VARCHAR(40) NULL AFTER material_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'shade_code');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN shade_code VARCHAR(80) NULL AFTER color_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
