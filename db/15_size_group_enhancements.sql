-- Migration 15: Size Group Master Enhancements & Ordered Size Scale

-- 1. Alter mst_size_group to add category, gender, buyer_id, description, is_active
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size_group' AND COLUMN_NAME = 'category');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size_group ADD COLUMN category VARCHAR(40) DEFAULT \'ADULT\' AFTER group_name', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size_group' AND COLUMN_NAME = 'gender');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size_group ADD COLUMN gender VARCHAR(40) DEFAULT \'UNISEX\' AFTER category', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size_group' AND COLUMN_NAME = 'buyer_id');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size_group ADD COLUMN buyer_id BIGINT UNSIGNED NULL AFTER gender', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size_group' AND COLUMN_NAME = 'description');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size_group ADD COLUMN description VARCHAR(255) NULL AFTER buyer_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size_group' AND COLUMN_NAME = 'is_active');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size_group ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER description', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Alter mst_size to add body_measurement & barcode_suffix
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size' AND COLUMN_NAME = 'body_measurement');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size ADD COLUMN body_measurement VARCHAR(80) NULL AFTER size_label', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mst_size' AND COLUMN_NAME = 'barcode_suffix');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE mst_size ADD COLUMN barcode_suffix VARCHAR(40) NULL AFTER body_measurement', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
