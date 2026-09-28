-- =====================================================================
-- 71. CANCEL A KNITTING YARN RETURN
-- ---------------------------------------------------------------------
-- A yarn return posted by mistake is cancelled, never deleted: its stock is
-- reversed out and the yarn counts as with the knitter again.
-- Idempotent: the migrate runner re-applies files.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_yarn_return' AND COLUMN_NAME='status');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_yarn_return ADD COLUMN status ENUM(\'ACTIVE\',\'CANCELLED\') NOT NULL DEFAULT \'ACTIVE\'', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_yarn_return' AND COLUMN_NAME='cancel_reason');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_yarn_return ADD COLUMN cancel_reason VARCHAR(255) NULL, ADD COLUMN cancelled_by BIGINT UNSIGNED NULL, ADD COLUMN cancelled_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
