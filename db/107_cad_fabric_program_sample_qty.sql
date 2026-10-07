-- 107_cad_fabric_program_sample_qty.sql
-- Add sample_qty column to trx_cad_fabric_program for explicit per-row sample fabric indents

SET @col_exist = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'trx_cad_fabric_program'
    AND COLUMN_NAME = 'sample_qty'
);

SET @sql = IF(
  @col_exist = 0,
  'ALTER TABLE trx_cad_fabric_program ADD COLUMN sample_qty DECIMAL(14,3) NOT NULL DEFAULT 0.000 AFTER buffer_qty;',
  'SELECT 1'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
