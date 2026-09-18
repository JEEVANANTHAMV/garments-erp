-- =====================================================================
-- 29. FABRIC PO: Grey / Dyed Fabric Category & Pantone/Spec Support
--     Mirrors the Grey Yarn / Dyed Yarn pattern from Yarn PO
-- =====================================================================

-- fabric_category: 'Grey Fabric' or 'Dyed Fabric' on PO line
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'fabric_category');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN fabric_category VARCHAR(40) NULL AFTER fabric_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- pantone_spec: Pantone reference / dyeing specification (Dyed Fabric only)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'pantone_spec');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN pantone_spec VARCHAR(80) NULL AFTER shade_code', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- color_name: Free-text color name on PO line (chart shows COLOR as a column)
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_purchase_order_line' AND COLUMN_NAME = 'color_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_purchase_order_line ADD COLUMN color_name VARCHAR(80) NULL AFTER color_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- GRN line: carry over fabric_category and pantone_spec
SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'fabric_category');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN fabric_category VARCHAR(40) NULL AFTER fabric_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'pantone_spec');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN pantone_spec VARCHAR(80) NULL AFTER fabric_category', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exist = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_grn_line' AND COLUMN_NAME = 'color_name');
SET @sql = IF(@col_exist = 0, 'ALTER TABLE trx_grn_line ADD COLUMN color_name VARCHAR(80) NULL AFTER pantone_spec', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
