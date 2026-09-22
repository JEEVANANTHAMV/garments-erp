-- =====================================================================
-- 47. PART NAME CARRY-FORWARD  (Sales Order -> ... -> Shipment)
-- ---------------------------------------------------------------------
-- Audio 5: the garment part (TOP / BOTTOM / COLLAR / CUFF / FOLDING) is
-- chosen next to the colour on the Sales Order line and must follow the
-- order through every downstream stage, right up to shipment.
--
-- part_name already exists on trx_sales_order_line, trx_knitting_program,
-- trx_knitting_order and trx_cutting_plan. This migration:
--   a) adds so_line_id where missing, so the part can be RESOLVED from the
--      originating SO line rather than retyped, and
--   b) adds part_name to the remaining downstream documents.
--
-- Written with prepared statements (no DELIMITER / stored procedures):
-- the migration runner sends each file as one multi-statement query and
-- DELIMITER is a client-side directive it does not understand.
-- =====================================================================

-- trx_cutting_plan.so_line_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND COLUMN_NAME='so_line_id');
SET @s = IF(@x=0, 'ALTER TABLE `trx_cutting_plan` ADD COLUMN `so_line_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_knitting_program.so_line_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND COLUMN_NAME='so_line_id');
SET @s = IF(@x=0, 'ALTER TABLE `trx_knitting_program` ADD COLUMN `so_line_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_knitting_order.so_line_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_order' AND COLUMN_NAME='so_line_id');
SET @s = IF(@x=0, 'ALTER TABLE `trx_knitting_order` ADD COLUMN `so_line_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_packing.so_line_id
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND COLUMN_NAME='so_line_id');
SET @s = IF(@x=0, 'ALTER TABLE `trx_packing` ADD COLUMN `so_line_id` BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_production_order.part_name
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_production_order' AND COLUMN_NAME='part_name');
SET @s = IF(@x=0, 'ALTER TABLE `trx_production_order` ADD COLUMN `part_name` VARCHAR(50) NULL COMMENT ''Carried from SO line''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_packing.part_name
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_packing' AND COLUMN_NAME='part_name');
SET @s = IF(@x=0, 'ALTER TABLE `trx_packing` ADD COLUMN `part_name` VARCHAR(50) NULL COMMENT ''Carried from SO line''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- trx_carton_content.part_name
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_carton_content' AND COLUMN_NAME='part_name');
SET @s = IF(@x=0, 'ALTER TABLE `trx_carton_content` ADD COLUMN `part_name` VARCHAR(50) NULL COMMENT ''Carried from SO line''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- index ix_cplan_soline
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_plan' AND INDEX_NAME='ix_cplan_soline');
SET @s = IF(@x=0, 'CREATE INDEX ix_cplan_soline ON trx_cutting_plan(so_line_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- index ix_kp_soline
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND INDEX_NAME='ix_kp_soline');
SET @s = IF(@x=0, 'CREATE INDEX ix_kp_soline ON trx_knitting_program(so_line_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Backfill part_name onto existing production orders from their SO line.
UPDATE trx_production_order po
  JOIN trx_sales_order_line sol ON sol.id = po.so_line_id
   SET po.part_name = sol.part_name
 WHERE po.part_name IS NULL AND sol.part_name IS NOT NULL;
