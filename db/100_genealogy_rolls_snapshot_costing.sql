-- 100: job material genealogy document (03-Oct-2026) — the remaining sections.
--   * Process quotation rolls (§9.2, §18, §19): the rolls a process quotation line is for, with the KG taken from each.
--     A roll cannot be over-allocated across live quotations.
--   * Process quotation costing + approval (§17): process / dye-chemical / other rate per KG; approved by / at.
--   * Job material requirement snapshot (§5.1): the job's planned requirement frozen from its BOM, by revision.
--   * Roll split / merge (§5.3, §6) use trx_fabric_roll.parent_roll_id + roll history; merged sources in roll history.
--   * Indexes (§24).
-- Re-runnable.

CREATE TABLE IF NOT EXISTS trx_quotation_roll (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  quotation_id     BIGINT UNSIGNED NOT NULL,
  quotation_line_id BIGINT UNSIGNED NULL,
  line_sort        INT NOT NULL DEFAULT 0 COMMENT 'Position of the line on the quotation (lines are rewritten on save)',
  fabric_roll_id   BIGINT UNSIGNED NOT NULL,
  so_id            BIGINT UNSIGNED NULL,
  roll_no          VARCHAR(60) NOT NULL,
  qty_kg           DECIMAL(14,3) NOT NULL,
  qty_m            DECIMAL(14,3) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_qr_quotation (quotation_id),
  KEY ix_qr_roll (fabric_roll_id)
) ENGINE=InnoDB COMMENT='Fabric rolls a process quotation line is for';

CREATE TABLE IF NOT EXISTS trx_job_material_requirement (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id    BIGINT UNSIGNED NOT NULL,
  so_id         BIGINT UNSIGNED NOT NULL,
  revision_no   INT NOT NULL,
  bom_id        BIGINT UNSIGNED NULL,
  bom_no        VARCHAR(60) NULL,
  material_type VARCHAR(20) NOT NULL,
  yarn_id       BIGINT UNSIGNED NULL,
  fabric_id     BIGINT UNSIGNED NULL,
  trim_id       BIGINT UNSIGNED NULL,
  material_name VARCHAR(255) NULL,
  required_qty  DECIMAL(18,3) NOT NULL,
  uom_id        BIGINT UNSIGNED NULL,
  uom_code      VARCHAR(20) NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / CLOSED (an older revision)',
  remarks       VARCHAR(255) NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_jmr_job (company_id, so_id, status)
) ENGINE=InnoDB COMMENT='Job material requirement snapshot (planned qty, never overwritten)';

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='process_rate');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN process_rate DECIMAL(14,4) NULL COMMENT ''Process charge per KG''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='dye_chem_rate');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN dye_chem_rate DECIMAL(14,4) NULL COMMENT ''Dye / chemical cost per KG''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation_line' AND COLUMN_NAME='other_rate');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation_line ADD COLUMN other_rate DECIMAL(14,4) NULL COMMENT ''Other cost per KG''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation' AND COLUMN_NAME='approved_by');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation ADD COLUMN approved_by BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_quotation' AND COLUMN_NAME='approved_at');
SET @s = IF(@x=0, 'ALTER TABLE trx_quotation ADD COLUMN approved_at DATETIME NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND INDEX_NAME='ix_froll_job_status');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD KEY ix_froll_job_status (company_id, so_id, stock_status, qc_status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND INDEX_NAME='ix_froll_parent');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll ADD KEY ix_froll_parent (parent_roll_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND INDEX_NAME='ix_fpri_roll');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD KEY ix_fpri_roll (fabric_roll_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_order' AND INDEX_NAME='ix_fpo_quotation');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_order ADD KEY ix_fpo_quotation (company_id, quotation_id, status)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll_history' AND INDEX_NAME='ix_frh_event');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll_history ADD KEY ix_frh_event (company_id, event)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
