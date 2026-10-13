-- 114: In-house unit DCs book the line's output (client voice note 13-Oct-2026, "no double entry in daily plans").
-- A DC to an in-house unit keeps the bundle's line allocation of the same process (stitching / checking / ironing /
-- packing); the line is remembered per DC line and the inward's good PCS complete that allocation and achieve its
-- daily plan. Re-runnable; every ALTER is guarded.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan_line' AND COLUMN_NAME='own_line_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan_line ADD COLUMN own_line_proc VARCHAR(10) NULL COMMENT ''sewing / checking / ironing / packing line doing this work (in-house unit DC)'', ADD COLUMN own_line_id BIGINT UNSIGNED NULL COMMENT ''line whose allocation + daily plan the inward books''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
