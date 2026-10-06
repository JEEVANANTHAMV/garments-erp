-- Migration 106: Style Versioning (v1, v2) and SKU Audit Visibility (Audio 1)
-- Tracks style specification & size revisions across versions.

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS 
   WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = 'mst_style' 
     AND COLUMN_NAME = 'version_no'
);

SET @sql = IF(@col_exists = 0, 
  'ALTER TABLE mst_style ADD COLUMN version_no INT NOT NULL DEFAULT 1 AFTER description', 
  'SELECT "Column version_no already exists in mst_style"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Ensure version_no is at least 1 for all existing rows
UPDATE mst_style SET version_no = 1 WHERE version_no IS NULL OR version_no = 0;
