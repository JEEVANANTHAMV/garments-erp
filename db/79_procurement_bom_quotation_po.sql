-- =====================================================================
-- 79 · BOM → Quotation → PO → GRN chain (client voice note 29-Sep-2026).
--   * trx_quotation_line : material link (material_type + fabric / yarn / trim id),
--                          job link (so_id) and source BOM line (bom_line_id), so a
--                          purchase quotation loaded from a job's BOM converts into
--                          a Fabric / Yarn / Trims PO with the right materials.
--                          qty widened INT → DECIMAL(18,4) (BOM requirements are in
--                          KG / MTR with decimals; INT silently rounded them).
--   * trx_trim_po        : quotation_id, like trx_purchase_order.quotation_id.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. trx_quotation_line — material / job / BOM links
-- ---------------------------------------------------------------------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='material_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN material_type VARCHAR(20) NULL COMMENT ''FABRIC / YARN / TRIM / ACCESSORY / PACKING / GENERAL'' AFTER style_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='fabric_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN fabric_id BIGINT UNSIGNED NULL AFTER material_type', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='yarn_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN yarn_id BIGINT UNSIGNED NULL AFTER fabric_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='trim_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN trim_id BIGINT UNSIGNED NULL AFTER yarn_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='so_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN so_id BIGINT UNSIGNED NULL COMMENT ''Job (sales order) the line is quoted for'' AFTER job_no', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='bom_line_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN bom_line_id BIGINT UNSIGNED NULL COMMENT ''Source trx_bom_line when loaded from BOM'' AFTER trim_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- qty: INT UNSIGNED → DECIMAL(18,4) (only while it is still an integer column)
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='qty' AND DATA_TYPE IN ('int','smallint','mediumint','bigint','tinyint'));
SET @s = IF(@x=1, 'ALTER TABLE trx_quotation_line MODIFY COLUMN qty DECIMAL(18,4) NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND INDEX_NAME='ix_quol_so');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD KEY ix_quol_so (so_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------
-- 2. trx_trim_po — source quotation (Trims Quotation → Trims PO)
-- ---------------------------------------------------------------------
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_po' AND COLUMN_NAME='quotation_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_po ADD COLUMN quotation_id BIGINT UNSIGNED NULL AFTER po_date', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_trim_po' AND INDEX_NAME='ix_tpo_quotation');
SET @s = IF(@x=0, 'ALTER TABLE trx_trim_po ADD KEY ix_tpo_quotation (quotation_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
