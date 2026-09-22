-- Migration 38: BOM Developer Specification Enhancements
-- Aligns trx_bom and trx_bom_line with Garment_ERP_Complete_BOM_Developer_Document.docx

-- 1. Extend material_type enum to include ACCESSORY, PACKING, GENERAL
ALTER TABLE `trx_bom_line` 
  MODIFY COLUMN `material_type` ENUM('YARN','FABRIC','TRIM','ACCESSORY','PACKING','GENERAL') NOT NULL;

-- 2. Add consumption_basis
SET @c1 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'consumption_basis');
SET @s1 = IF(@c1 = 0, 'ALTER TABLE `trx_bom_line` ADD COLUMN `consumption_basis` VARCHAR(30) NOT NULL DEFAULT \'PER_PIECE\' AFTER `size_id`', 'SELECT 1');
PREPARE st1 FROM @s1; EXECUTE st1; DEALLOCATE PREPARE st1;

-- 3. Add applicability
SET @c2 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'applicability');
SET @s2 = IF(@c2 = 0, 'ALTER TABLE `trx_bom_line` ADD COLUMN `applicability` VARCHAR(30) NOT NULL DEFAULT \'ALL\' AFTER `consumption_basis`', 'SELECT 1');
PREPARE st2 FROM @s2; EXECUTE st2; DEALLOCATE PREPARE st2;

-- 4. Add additional_qty
SET @c3 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'additional_qty');
SET @s3 = IF(@c3 = 0, 'ALTER TABLE `trx_bom_line` ADD COLUMN `additional_qty` DECIMAL(18,5) NOT NULL DEFAULT 0.00000 AFTER `consumption`', 'SELECT 1');
PREPARE st3 FROM @s3; EXECUTE st3; DEALLOCATE PREPARE st3;

-- 5. Add item_description
SET @c4 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'item_description');
SET @s4 = IF(@c4 = 0, 'ALTER TABLE `trx_bom_line` ADD COLUMN `item_description` VARCHAR(255) NULL AFTER `trim_id`', 'SELECT 1');
PREPARE st4 FROM @s4; EXECUTE st4; DEALLOCATE PREPARE st4;

-- 6. Add approval_state to trx_bom
SET @c5 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approval_state');
SET @s5 = IF(@c5 = 0, 'ALTER TABLE `trx_bom` ADD COLUMN `approval_state` ENUM(\'DRAFT\',\'SUBMITTED\',\'APPROVED\',\'SUPERSEDED\',\'CANCELLED\') NOT NULL DEFAULT \'DRAFT\' AFTER `status_id`', 'SELECT 1');
PREPARE st5 FROM @s5; EXECUTE st5; DEALLOCATE PREPARE st5;

-- 7. Add approved_by to trx_bom
SET @c6 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approved_by');
SET @s6 = IF(@c6 = 0, 'ALTER TABLE `trx_bom` ADD COLUMN `approved_by` BIGINT UNSIGNED NULL AFTER `created_by`', 'SELECT 1');
PREPARE st6 FROM @s6; EXECUTE st6; DEALLOCATE PREPARE st6;

-- 8. Add approved_at to trx_bom
SET @c7 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approved_at');
SET @s7 = IF(@c7 = 0, 'ALTER TABLE `trx_bom` ADD COLUMN `approved_at` DATETIME NULL AFTER `approved_by`', 'SELECT 1');
PREPARE st7 FROM @s7; EXECUTE st7; DEALLOCATE PREPARE st7;
