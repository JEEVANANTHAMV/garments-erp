-- Migration 38: BOM Developer Specification Enhancements
-- Aligns trx_bom and trx_bom_line with Garment_ERP_Complete_BOM_Developer_Document.docx

-- 1. Extend material_type enum to include ACCESSORY, PACKING, GENERAL
ALTER TABLE `trx_bom_line` 
  MODIFY COLUMN `material_type` ENUM('YARN','FABRIC','TRIM','ACCESSORY','PACKING','GENERAL') NOT NULL;

-- 2. Add consumption_basis, applicability, additional_qty, item_description
ALTER TABLE `trx_bom_line`
  ADD COLUMN IF NOT EXISTS `consumption_basis` VARCHAR(30) NOT NULL DEFAULT 'PER_PIECE' AFTER `size_id`,
  ADD COLUMN IF NOT EXISTS `applicability` VARCHAR(30) NOT NULL DEFAULT 'ALL' AFTER `consumption_basis`,
  ADD COLUMN IF NOT EXISTS `additional_qty` DECIMAL(18,5) NOT NULL DEFAULT 0.00000 AFTER `consumption`,
  ADD COLUMN IF NOT EXISTS `item_description` VARCHAR(255) NULL AFTER `trim_id`;

-- 3. Add approval and versioning columns to trx_bom if not present
ALTER TABLE `trx_bom`
  ADD COLUMN IF NOT EXISTS `approval_state` ENUM('DRAFT','SUBMITTED','APPROVED','SUPERSEDED','CANCELLED') NOT NULL DEFAULT 'DRAFT' AFTER `status_id`,
  ADD COLUMN IF NOT EXISTS `approved_by` BIGINT UNSIGNED NULL AFTER `created_by`,
  ADD COLUMN IF NOT EXISTS `approved_at` DATETIME NULL AFTER `approved_by`;
