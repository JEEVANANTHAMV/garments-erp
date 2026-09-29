-- =====================================================================
-- 76 · Process DC ↔ in-house line allocation
--   release_line_alloc = 1 → issuing the DC releases the bundles' in-house
--   line allocation (and open daily-plan rows) for the PCS sent out.
--   Without it, a bundle allocated to an in-house line cannot go on a
--   stitching / ironing / packing DC. Idempotent.
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='release_line_alloc');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN release_line_alloc TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1 = release in-house line allocation of the bundles on issue''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
