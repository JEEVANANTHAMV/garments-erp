-- 95: Fabric roll GSM + Dia/Width + meter calculation (client doc "Knitting_GSM_Dia_Fabric_Roll_Calculation", 03-Oct-2026).
--   Meter = KG × 1000 ÷ (GSM × width in metres); width from Dia through an approved, effective-dated Dia/Width rule.
--   Each roll keeps target GSM vs actual GSM and calculated meter vs actual meter with the variance, so the
--   ERP's auto figure and what was actually received sit side by side.
-- Re-runnable.

CREATE TABLE IF NOT EXISTS mst_dia_width_rule (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id       BIGINT UNSIGNED NOT NULL,
  rule_code        VARCHAR(30) NOT NULL,
  fabric_form      VARCHAR(12) NOT NULL COMMENT 'TUBULAR / OPEN_WIDTH',
  dia_definition   VARCHAR(60) NOT NULL COMMENT 'What "Dia" means in this factory: finished tubular (flat) width, open width, machine dia …',
  formula_type     VARCHAR(15) NOT NULL DEFAULT 'FACTOR' COMMENT 'DIRECT (width = dia) / FACTOR (width = dia × factor) / CIRCUMFERENCE (width = dia × π)',
  factor           DECIMAL(10,5) NOT NULL DEFAULT 1,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL,
  approval_status  VARCHAR(20) NOT NULL DEFAULT 'APPROVED' COMMENT 'DRAFT / APPROVED',
  approved_by      BIGINT UNSIGNED NULL,
  approved_at      DATETIME NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  remarks          VARCHAR(255) NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dwr (company_id, rule_code),
  KEY ix_dwr_form (company_id, fabric_form, effective_from)
) ENGINE=InnoDB COMMENT='Dia → fabric width conversion rules (effective dated, approved)';

-- default rules: tubular Dia = flat width (fabric width = 2 × Dia), open width Dia = width
INSERT IGNORE INTO mst_dia_width_rule (company_id, rule_code, fabric_form, dia_definition, formula_type, factor, effective_from, approval_status, approved_at, remarks)
SELECT c.id, 'TUBE-FLAT-X2', 'TUBULAR', 'Finished tubular (flat) Dia', 'FACTOR', 2, '2020-01-01', 'APPROVED', NOW(), 'Width = Dia × 2 (both layers of the tube)' FROM mst_company c;
INSERT IGNORE INTO mst_dia_width_rule (company_id, rule_code, fabric_form, dia_definition, formula_type, factor, effective_from, approval_status, approved_at, remarks)
SELECT c.id, 'OPEN-DIRECT', 'OPEN_WIDTH', 'Open width', 'DIRECT', 1, '2020-01-01', 'APPROVED', NOW(), 'Width = Dia' FROM mst_company c;

-- roll calculation columns (meters stays the operational meter: actual when measured, else calculated)
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_roll' AND COLUMN_NAME='calc_meters');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_roll
  ADD COLUMN fabric_form VARCHAR(12) NULL COMMENT ''TUBULAR / OPEN_WIDTH'',
  ADD COLUMN target_gsm DECIMAL(10,3) NULL COMMENT ''Specification GSM'',
  ADD COLUMN actual_gsm DECIMAL(10,3) NULL COMMENT ''QC GSM (entered, or from KG + actual meter)'',
  ADD COLUMN width_m DECIMAL(12,5) NULL COMMENT ''Fabric width in metres from Dia + rule'',
  ADD COLUMN dia_rule_id BIGINT UNSIGNED NULL,
  ADD COLUMN calc_meters DECIMAL(12,3) NULL COMMENT ''KG × 1000 ÷ (GSM × width M)'',
  ADD COLUMN actual_meters DECIMAL(12,3) NULL COMMENT ''Measured meter'',
  ADD COLUMN meter_var_pct DECIMAL(8,3) NULL,
  ADD COLUMN gsm_var_pct DECIMAL(8,3) NULL,
  ADD COLUMN calc_basis VARCHAR(20) NULL COMMENT ''TARGET_GSM / ACTUAL_GSM'',
  ADD COLUMN gsm_flag VARCHAR(20) NULL COMMENT ''OUT_OF_TOLERANCE when actual GSM / meter variance is outside the limits''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- knitting program: fabric form (tubular / open) next to target GSM / Dia
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND COLUMN_NAME='fabric_form');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_program ADD COLUMN fabric_form VARCHAR(12) NULL COMMENT ''TUBULAR / OPEN_WIDTH'' AFTER dia', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- tolerances (editable under Admin › Settings)
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ROLL_GSM_TOLERANCE_PCT', '5', 'Fabric roll: actual GSM may differ from target by this % (used when the fabric has no GSM min / max); outside → roll on QC hold' FROM mst_company;
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'ROLL_METER_VARIANCE_PCT', '5', 'Fabric roll: actual meter may differ from the calculated meter by this %; outside → roll on QC hold' FROM mst_company;
