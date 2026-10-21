-- =====================================================================
-- 136 · Business partner role: Transporter (client 21-Oct-2026)
--   "Every list shows only its own role — buyer fields buyers, supplier fields suppliers, job-worker fields job workers."
--   Transporters had no role and were tagged as job workers (Blue Dart Logistics) to show up on dispatch.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mst_party' AND COLUMN_NAME='is_transporter');
SET @s = IF(@x=0, 'ALTER TABLE mst_party ADD COLUMN is_transporter TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''Transporter / logistics partner'' AFTER is_contractor', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
