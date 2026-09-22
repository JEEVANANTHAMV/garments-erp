-- Migration 38: BOM Developer Specification Enhancements
-- Aligns trx_bom and trx_bom_line with Garment_ERP_Complete_BOM_Developer_Document.docx

-- 1. Extend material_type enum to include ACCESSORY, PACKING, GENERAL
ALTER TABLE `trx_bom_line` 
  MODIFY COLUMN `material_type` ENUM('YARN','FABRIC','TRIM','ACCESSORY','PACKING','GENERAL') NOT NULL;

-- 2. Add consumption_basis, applicability, additional_qty, item_description idempotently
DROP PROCEDURE IF EXISTS _patch_migration_38;
DELIMITER $$
CREATE PROCEDURE _patch_migration_38()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'consumption_basis') THEN
    ALTER TABLE `trx_bom_line` ADD COLUMN `consumption_basis` VARCHAR(30) NOT NULL DEFAULT 'PER_PIECE' AFTER `size_id`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'applicability') THEN
    ALTER TABLE `trx_bom_line` ADD COLUMN `applicability` VARCHAR(30) NOT NULL DEFAULT 'ALL' AFTER `consumption_basis`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'additional_qty') THEN
    ALTER TABLE `trx_bom_line` ADD COLUMN `additional_qty` DECIMAL(18,5) NOT NULL DEFAULT 0.00000 AFTER `consumption`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom_line' AND COLUMN_NAME = 'item_description') THEN
    ALTER TABLE `trx_bom_line` ADD COLUMN `item_description` VARCHAR(255) NULL AFTER `trim_id`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approval_state') THEN
    ALTER TABLE `trx_bom` ADD COLUMN `approval_state` ENUM('DRAFT','SUBMITTED','APPROVED','SUPERSEDED','CANCELLED') NOT NULL DEFAULT 'DRAFT' AFTER `status_id`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approved_by') THEN
    ALTER TABLE `trx_bom` ADD COLUMN `approved_by` BIGINT UNSIGNED NULL AFTER `created_by`;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_bom' AND COLUMN_NAME = 'approved_at') THEN
    ALTER TABLE `trx_bom` ADD COLUMN `approved_at` DATETIME NULL AFTER `approved_by`;
  END IF;
END$$
DELIMITER ;

CALL _patch_migration_38();
DROP PROCEDURE IF EXISTS _patch_migration_38;
