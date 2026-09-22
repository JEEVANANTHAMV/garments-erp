-- ─────────────────────────────────────────────────────────────────
-- Migration 45: Add customer_po_no to trx_knitting_order
-- ─────────────────────────────────────────────────────────────────

SET @col_exist = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'trx_knitting_order'
    AND COLUMN_NAME  = 'customer_po_no'
);
SET @sql = IF(
  @col_exist = 0,
  'ALTER TABLE trx_knitting_order ADD COLUMN customer_po_no VARCHAR(60) NULL DEFAULT NULL AFTER io_no',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
