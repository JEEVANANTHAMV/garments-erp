-- =====================================================================
-- Migration 51: Packing List Type (ASSORTED / SOLID / MIXED)
-- Supports the 3 formats used in production:
--   ASSORTED - Multiple sizes in one carton (size ratio per box)
--   SOLID    - One size per carton (numeric / EU sizes)
--   MIXED    - Combines two size sets (e.g. children 3A-14A + adult S-XL)
-- =====================================================================

SET @col_exist = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME  = 'trx_packing_list'
    AND COLUMN_NAME = 'pl_type'
);
SET @sql = IF(@col_exist = 0,
  "ALTER TABLE trx_packing_list
     ADD COLUMN pl_type      ENUM('ASSORTED','SOLID','MIXED') NOT NULL DEFAULT 'ASSORTED' AFTER status,
     ADD COLUMN size_headers JSON NULL COMMENT 'Custom ordered size labels for this packing list (e.g. [\"S\",\"M\",\"L\",\"XL\"] or [\"36\",\"38\",\"40\"])'",
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
