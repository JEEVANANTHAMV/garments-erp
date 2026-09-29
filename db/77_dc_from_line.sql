-- =====================================================================
-- 77 · Process DC "from line": bundles picked from a line's allocation;
--   issuing the DC books that line's output (allocation completed / daily
--   plan achieved), so the move needs one entry, not two. Idempotent.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='from_line_proc');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN from_line_proc VARCHAR(20) NULL COMMENT ''Line process the bundles come from (sewing / checking / ironing)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='from_line_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN from_line_id INT UNSIGNED NULL COMMENT ''Line whose output this DC carries''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
