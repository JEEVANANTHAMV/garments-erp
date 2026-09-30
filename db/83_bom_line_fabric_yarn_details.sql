-- =====================================================================
-- 83: BOM fabric / yarn line details (client voice note 30-Sep-2026)
--   Fabric: Dia + GSM (from the Dia / GSM masters), Grey or Dyed, colour when dyed.
--   Yarn:   yarn base + count (from the Yarn Count master), Grey or Dyed, colour when dyed.
--   The yarn variant (base + count, mst_yarn) is resolved / created on save, so
--   yarn_id stays the key POs, quotations and MRP use. Idempotent (re-runs every deploy).
-- =====================================================================
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='dia');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN dia VARCHAR(20) NULL COMMENT ''Fabric dia (Dia master), e.g. 34"'' AFTER specification', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='gsm');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN gsm INT UNSIGNED NULL COMMENT ''Fabric GSM (GSM master)'' AFTER dia', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='yarn_base_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN yarn_base_id BIGINT UNSIGNED NULL COMMENT ''Yarn base picked on the BOM'' AFTER gsm', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='yarn_count_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN yarn_count_id BIGINT UNSIGNED NULL COMMENT ''Yarn count (Yarn Count master)'' AFTER yarn_base_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='dye_type');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN dye_type VARCHAR(10) NULL COMMENT ''GREY / DYED (fabric and yarn)'' AFTER yarn_count_id', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_bom_line' AND COLUMN_NAME='material_color_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_bom_line ADD COLUMN material_color_id BIGINT UNSIGNED NULL COMMENT ''Colour of dyed fabric / yarn (not the garment colour split)'' AFTER dye_type', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
