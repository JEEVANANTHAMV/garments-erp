-- =====================================================================
-- 42. GARMENT PRODUCTION PART (TOP, BOTTOM, FOLDING) ENHANCEMENTS
-- =====================================================================

-- 1. Extend trx_cutting_bundle with part_name, bundle_seq, total_bundles
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cutting_bundle' AND COLUMN_NAME = 'part_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN part_name VARCHAR(50) NULL DEFAULT ''TOP'' AFTER size_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cutting_bundle' AND COLUMN_NAME = 'bundle_seq');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN bundle_seq INT UNSIGNED NULL AFTER bundle_no', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cutting_bundle' AND COLUMN_NAME = 'total_bundles');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN total_bundles INT UNSIGNED NULL AFTER bundle_seq', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Make sku_id NULLable on trx_cutting_bundle if not already
ALTER TABLE trx_cutting_bundle MODIFY COLUMN sku_id BIGINT UNSIGNED NULL;

-- 2. Extend trx_cutting_plan with part_name
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_cutting_plan' AND COLUMN_NAME = 'part_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_cutting_plan ADD COLUMN part_name VARCHAR(50) NULL DEFAULT ''TOP'' AFTER color_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Extend trx_production_costing_labour with part_name, piece_rate, pieces_completed
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_costing_labour' AND COLUMN_NAME = 'part_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_costing_labour ADD COLUMN part_name VARCHAR(50) NULL DEFAULT ''TOP'' AFTER department_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_costing_labour' AND COLUMN_NAME = 'piece_rate');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_costing_labour ADD COLUMN piece_rate DECIMAL(10,2) NULL DEFAULT 0.00 AFTER rate_per_hour', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_costing_labour' AND COLUMN_NAME = 'pieces_completed');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_costing_labour ADD COLUMN pieces_completed INT UNSIGNED NULL DEFAULT 0 AFTER hours', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Extend trx_production_costing_process with part_name
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_production_costing_process' AND COLUMN_NAME = 'part_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_production_costing_process ADD COLUMN part_name VARCHAR(50) NULL DEFAULT ''TOP'' AFTER process_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
