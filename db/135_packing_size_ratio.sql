-- =====================================================================
-- 135 · Size ratio per carton / master polybag (client audio 16-Oct-2026)
--   "Give a ratio for the carton box and the master polybag (S2 M4 L4 XL2 = 1:2:2:1) so the pieces fill
--    automatically per box / bag. Not needed for single packs."
--   trx_packing.size_ratio  JSON [{size_id, ratio}] — the buyer gives it per order. A full carton holds the
--   ratio scaled to the carton capacity; a master polybag the ratio scaled to its pieces.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND COLUMN_NAME='size_ratio');
SET @s = IF(@x=0, 'ALTER TABLE trx_packing ADD COLUMN size_ratio JSON NULL COMMENT ''Size ratio per carton / master polybag: [{size_id, ratio}]''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
