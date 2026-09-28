-- =====================================================================
-- 68. MERCHANDISER PRE-COSTING V2 — CUTTING / PROCESSES / FINISHING &
--     PACKING / OTHER DIRECT / OVERHEAD TABS
-- ---------------------------------------------------------------------
-- The tab rows live in trx_costing.data_json; the server rolls them into
-- the per-piece head columns on every save. "Other" rows of the Other
-- Direct tab (anything that is not testing, freight, agent commission or
-- finance) need their own head so they are not hidden inside another one.
-- Idempotent: every statement is guarded.
-- =====================================================================

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_costing' AND COLUMN_NAME='other_direct_cost');
SET @s = IF(@x=0, 'ALTER TABLE trx_costing ADD COLUMN other_direct_cost DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT \'Pre-costing Other Direct tab: charges that are not testing / freight / commission / finance, per PC\' AFTER finance_cost', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
